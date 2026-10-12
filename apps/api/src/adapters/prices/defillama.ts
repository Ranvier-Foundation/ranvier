import { getChain, knownDecimals, NATIVE } from '@ranvier/chains';
import type { TokenRef } from '@ranvier/types';
import { z } from 'zod';
import type { PriceOracle, TokenPrice } from '../../ports/price-oracle.js';
import { parseDecimalScaled } from './decimal.js';

/** A JSON number kept as its exact source text, so it never passes through a float. */
class JsonNumber {
  constructor(readonly source: string) {}
}

/** `price` must be a JSON number; `parseExact` hands it over as a `JsonNumber`. */
const coinSchema = z.object({
  price: z.instanceof(JsonNumber),
  /** ERC-20 / SPL decimals from DefiLlama's token metadata; outside 0..36 is malformed. */
  decimals: z.number().int().min(0).max(36).optional(),
  timestamp: z.number(),
  /** Required: a price DefiLlama does not score is not trusted (fail closed). */
  confidence: z.number().min(0).max(1),
});
const responseSchema = z.object({ coins: z.record(z.string(), coinSchema) });

export interface DefiLlamaOptions {
  baseUrl?: string;
  /** Reject prices older than this. */
  maxAgeSeconds?: number;
  /** Reject prices DefiLlama scores below this (0 to 1). */
  minConfidence?: number;
  /** Reuse a fetched price for this long. */
  cacheTtlMs?: number;
  /** Upper bound on cached tokens; the least recently used entry is evicted first. */
  maxCacheEntries?: number;
  /** Remember a failed lookup for this long, so a dead token cannot hammer the oracle. */
  failureTtlMs?: number;
  /** Largest response body read; larger responses are refused. */
  maxBodyBytes?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const PRICE_SCALE = 18;

type CacheEntry = { price: TokenPrice; at: number } | { error: PriceUnavailableError; at: number };

export class PriceUnavailableError extends Error {
  override readonly name = 'PriceUnavailableError';
}

interface JsonSourceContext {
  source?: string;
}

/**
 * JSON.parse that keeps every `price` as its exact source text (JSON.parse source text
 * access, Node 21+), so a price like 4.2e-7 is converted without passing through a float.
 */
function parseExact(text: string): unknown {
  try {
    return JSON.parse(text, (key: string, value: unknown, context?: JsonSourceContext) => {
      if (key !== 'price' || typeof value !== 'number') return value;
      if (context?.source === undefined) throw new Error('no JSON source text access');
      return new JsonNumber(context.source);
    });
  } catch {
    throw new PriceUnavailableError('unparseable DefiLlama response');
  }
}

/** Reads at most `limit` bytes of the body, cancelling the stream past it. */
async function readBounded(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > limit) throw new PriceUnavailableError('DefiLlama response too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new PriceUnavailableError('DefiLlama response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** USD prices and token decimals from the DefiLlama coins API (free, no key). */
export class DefiLlamaPriceOracle implements PriceOracle {
  private readonly baseUrl: string;
  private readonly maxAgeSeconds: number;
  private readonly minConfidence: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly failureTtlMs: number;
  private readonly maxBodyBytes: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<TokenPrice>>();

  constructor(opts: DefiLlamaOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://coins.llama.fi';
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 600;
    this.minConfidence = opts.minConfidence ?? 0.9;
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.maxCacheEntries = Math.max(1, opts.maxCacheEntries ?? 1_000);
    this.failureTtlMs = opts.failureTtlMs ?? 10_000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  async price(token: TokenRef, signal: AbortSignal): Promise<TokenPrice> {
    // Keyed by the token as requested, so native and wrapped native keep their own decimals.
    const key = `${token.chain}/${token.address}`;
    const cached = this.cache.get(key);
    if (cached) {
      const ttl = 'price' in cached ? this.cacheTtlMs : this.failureTtlMs;
      if (this.now() - cached.at < ttl) {
        this.touch(key, cached);
        if ('price' in cached) return cached.price;
        throw cached.error;
      }
    }
    // Identical concurrent lookups share one request. The first caller's signal governs it;
    // an abort is not cached, so later callers retry.
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const lookup = this.lookup(token, signal)
      .then((price) => {
        this.remember(key, { price, at: this.now() });
        return price;
      })
      .catch((err: unknown) => {
        if (err instanceof PriceUnavailableError)
          this.remember(key, { error: err, at: this.now() });
        throw err;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    return lookup;
  }

  private async lookup(token: TokenRef, signal: AbortSignal): Promise<TokenPrice> {
    const chain = getChain(token.chain);
    if (!chain) throw new PriceUnavailableError(`unknown chain ${token.chain}`);
    const isNative = token.address === NATIVE;
    // The native coin is priced through its wrapped token; its decimals come from the registry.
    const address = isNative ? chain.wrappedNative : token.address;
    const id = `${chain.defillama}:${address}`;

    const path = `${encodeURIComponent(chain.defillama)}:${encodeURIComponent(address)}`;
    const res = await this.fetch(`${this.baseUrl}/prices/current/${path}`, { signal });
    if (!res.ok) throw new PriceUnavailableError(`DefiLlama returned ${res.status}`);
    const parsed = responseSchema.safeParse(parseExact(await readBounded(res, this.maxBodyBytes)));
    if (!parsed.success) throw new PriceUnavailableError('malformed DefiLlama response');
    const coin = parsed.data.coins[id];
    if (!coin) throw new PriceUnavailableError(`no price for ${id}`);
    if (this.now() / 1000 - coin.timestamp > this.maxAgeSeconds) {
      throw new PriceUnavailableError(`stale price for ${id}`);
    }
    if (coin.confidence < this.minConfidence) {
      throw new PriceUnavailableError(`low-confidence price for ${id}`);
    }
    let usdE18: bigint;
    try {
      usdE18 = parseDecimalScaled(coin.price.source, PRICE_SCALE);
    } catch {
      throw new PriceUnavailableError(`unparseable price for ${id}`);
    }
    // Zero, negative, or below 10^-18 USD: no usable price.
    if (usdE18 <= 0n) throw new PriceUnavailableError(`non-positive price for ${id}`);

    // Native decimals come from the registry. For a token the registry lists, DefiLlama must
    // agree with the checked-in value; any other token relies on DefiLlama alone (ADR 0004).
    if (isNative) return { decimals: chain.nativeDecimals, usdE18 };
    if (coin.decimals === undefined) throw new PriceUnavailableError(`no decimals for ${id}`);
    const expected = knownDecimals(token.chain, token.address);
    if (expected !== undefined && expected !== coin.decimals) {
      throw new PriceUnavailableError(`decimals mismatch for ${id}`);
    }
    return { decimals: coin.decimals, usdE18 };
  }

  /** Marks an entry as recently used (Map iteration order is the LRU order). */
  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    // Map iteration order is least recently used first (`touch` re-inserts on every hit).
    const oldest = this.cache.keys().next();
    if (this.cache.size >= this.maxCacheEntries && !oldest.done) this.cache.delete(oldest.value);
    this.cache.set(key, entry);
  }
}

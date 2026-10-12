import { getChain, NATIVE } from '@ranvier/chains';
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
  /** ERC-20 / SPL decimals from DefiLlama's token metadata. */
  decimals: z.number().int().min(0).max(36).optional(),
  timestamp: z.number(),
  confidence: z.number().optional(),
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
  /** Upper bound on cached tokens; the oldest entry is evicted first. */
  maxCacheEntries?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const PRICE_SCALE = 18;

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

/** USD prices and token decimals from the DefiLlama coins API (free, no key). */
export class DefiLlamaPriceOracle implements PriceOracle {
  private readonly baseUrl: string;
  private readonly maxAgeSeconds: number;
  private readonly minConfidence: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { price: TokenPrice; at: number }>();

  constructor(opts: DefiLlamaOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://coins.llama.fi';
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 600;
    this.minConfidence = opts.minConfidence ?? 0.9;
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.maxCacheEntries = opts.maxCacheEntries ?? 1_000;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  async price(token: TokenRef, signal: AbortSignal): Promise<TokenPrice> {
    const chain = getChain(token.chain);
    if (!chain) throw new PriceUnavailableError(`unknown chain ${token.chain}`);
    const isNative = token.address === NATIVE;
    // The native coin is priced through its wrapped token; its decimals come from the registry.
    const address = isNative ? chain.wrappedNative : token.address;
    const id = `${chain.defillama}:${address}`;

    // Keyed by the token as requested, so native and wrapped native keep their own decimals.
    const cacheKey = `${token.chain}/${token.address}`;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.price;

    const path = `${encodeURIComponent(chain.defillama)}:${encodeURIComponent(address)}`;
    const res = await this.fetch(`${this.baseUrl}/prices/current/${path}`, { signal });
    if (!res.ok) throw new PriceUnavailableError(`DefiLlama returned ${res.status}`);
    const parsed = responseSchema.safeParse(parseExact(await res.text()));
    if (!parsed.success) throw new PriceUnavailableError('malformed DefiLlama response');
    const coin = parsed.data.coins[id];
    if (!coin) throw new PriceUnavailableError(`no price for ${id}`);
    if (this.now() / 1000 - coin.timestamp > this.maxAgeSeconds) {
      throw new PriceUnavailableError(`stale price for ${id}`);
    }
    if (coin.confidence !== undefined && coin.confidence < this.minConfidence) {
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
    const decimals = isNative ? chain.nativeDecimals : coin.decimals;
    if (decimals === undefined) throw new PriceUnavailableError(`no decimals for ${id}`);

    const price: TokenPrice = { decimals, usdE18 };
    this.remember(cacheKey, price);
    return price;
  }

  private remember(key: string, price: TokenPrice): void {
    this.cache.delete(key);
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { price, at: this.now() });
  }
}

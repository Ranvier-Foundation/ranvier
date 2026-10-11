import { getChain, NATIVE } from '@ranvier/chains';
import type { Token, UsdCents } from '@ranvier/types';
import { z } from 'zod';
import type { PriceOracle } from '../../ports/price-oracle.js';

const responseSchema = z.object({
  coins: z.record(
    z.string(),
    z.object({
      price: z.number().nonnegative(),
      timestamp: z.number(),
      confidence: z.number().optional(),
    }),
  ),
});

export interface DefiLlamaOptions {
  baseUrl?: string;
  /** Reject prices older than this. */
  maxAgeSeconds?: number;
  /** Reject prices DefiLlama scores below this (0 to 1). */
  minConfidence?: number;
  /** Reuse a fetched price for this long. */
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Prices are held as integer micro-USD so money maths stays in bigint. */
const MICRO_USD_PER_CENT = 10_000n;

export class PriceUnavailableError extends Error {}

/** USD prices from the DefiLlama coins API (free, no key). */
export class DefiLlamaPriceOracle implements PriceOracle {
  private readonly baseUrl: string;
  private readonly maxAgeSeconds: number;
  private readonly minConfidence: number;
  private readonly cacheTtlMs: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { microUsd: bigint; at: number }>();

  constructor(opts: DefiLlamaOptions = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://coins.llama.fi';
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 600;
    this.minConfidence = opts.minConfidence ?? 0.9;
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  async usdValue(token: Token, amount: bigint, signal: AbortSignal): Promise<UsdCents> {
    const microUsd = await this.priceMicroUsd(token, signal);
    return (amount * microUsd) / 10n ** BigInt(token.decimals) / MICRO_USD_PER_CENT;
  }

  private coinId(token: Token): string {
    const chain = getChain(token.chain);
    if (!chain) throw new PriceUnavailableError(`unknown chain ${token.chain}`);
    const address = token.address === NATIVE ? chain.wrappedNative : token.address;
    return `${chain.defillama}:${address}`;
  }

  private async priceMicroUsd(token: Token, signal: AbortSignal): Promise<bigint> {
    const id = this.coinId(token);
    const cached = this.cache.get(id);
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.microUsd;

    const res = await this.fetch(`${this.baseUrl}/prices/current/${id}`, { signal });
    if (!res.ok) throw new PriceUnavailableError(`DefiLlama returned ${res.status}`);
    const coin = responseSchema.parse(await res.json()).coins[id];
    if (!coin) throw new PriceUnavailableError(`no price for ${id}`);
    if (this.now() / 1000 - coin.timestamp > this.maxAgeSeconds) {
      throw new PriceUnavailableError(`stale price for ${id}`);
    }
    if (coin.confidence !== undefined && coin.confidence < this.minConfidence) {
      throw new PriceUnavailableError(`low-confidence price for ${id}`);
    }

    const microUsd = BigInt(Math.round(coin.price * 1_000_000));
    this.cache.set(id, { microUsd, at: this.now() });
    return microUsd;
  }
}

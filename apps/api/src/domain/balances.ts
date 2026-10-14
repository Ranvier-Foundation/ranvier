import { listTokens, NATIVE } from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import { ConcurrencyLimit, ConcurrencyLimitError } from '../lib/concurrency-limit.js';
import { ChainReadError, type ChainReader, type EvmAddress } from '../ports/chain-reader.js';

/**
 * Wallet balances for the token picker (ADR 0009): the native coin and every curated token of a
 * served EVM chain, read at one block through `ChainReader`.
 *
 * Display data only. Nothing here feeds fees, route vetting or signing.
 *
 * Load control, so one wallet (or a flood of wallets) cannot open unbounded RPC calls:
 * - a micro-cache per (chain, owner), bounded with least-recently-used eviction;
 * - failures are remembered for a short negative TTL only;
 * - identical concurrent requests share one read;
 * - at most `maxInFlightPerChain` reads per chain, `maxQueuePerChain` waiting, beyond that the
 *   request fails at once with `rpc_unavailable`;
 * - every read has a deadline; it is aborted once no caller is waiting for it.
 */

export interface BalanceEntry {
  /** `native` or a lowercase token address from the curated list. */
  address: typeof NATIVE | EvmAddress;
  /** Base units; null when that one read failed. */
  balance: bigint | null;
}

export interface WalletBalances {
  chain: ChainKey;
  /** The owner, lowercase. */
  address: EvmAddress;
  blockNumber: bigint;
  /** In token-list display order: the native coin first. */
  balances: readonly BalanceEntry[];
}

export interface BalanceServiceOptions {
  reader: ChainReader;
  /** EVM chain IDs the API serves (ZEROX_CHAIN_IDS). */
  servedChainIds: readonly number[];
  /** Reuse a successful read for this long (default 3000 ms). */
  cacheTtlMs?: number;
  /** Remember a failed read for this long (default 1000 ms). */
  failureTtlMs?: number;
  /** Cached (chain, owner) entries (default 5000), least recently used evicted first. */
  maxCacheEntries?: number;
  /** Longest a read may take, queueing included (default 3000 ms). */
  deadlineMs?: number;
  /** Reads running at once per chain (default 8). */
  maxInFlightPerChain?: number;
  /** Reads waiting for a slot per chain (default 32). */
  maxQueuePerChain?: number;
  now?: () => number;
}

interface ChainPlan {
  chainId: number;
  /** Non-native token addresses, in list order. */
  tokens: readonly EvmAddress[];
  /** Every entry in list order. */
  order: readonly (typeof NATIVE | EvmAddress)[];
}

type CacheEntry = { value: WalletBalances; at: number } | { error: ChainReadError; at: number };

interface Work {
  promise: Promise<WalletBalances>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

/** The served chain IDs that have a curated token list: the chains balances are offered for. */
export function balanceChainIds(servedChainIds: readonly number[]): number[] {
  return [...new Set(servedChainIds)].filter((id) => listTokens(`evm:${id}`).length > 0);
}

function plan(chainId: number): ChainPlan {
  const list = listTokens(`evm:${chainId}`);
  const order = list.map((t) => (t.address === NATIVE ? NATIVE : (t.address as EvmAddress)));
  return {
    chainId,
    tokens: order.filter((a): a is EvmAddress => a !== NATIVE),
    order,
  };
}

export class BalanceService {
  private readonly plans = new Map<ChainKey, ChainPlan>();
  private readonly limits = new Map<number, ConcurrencyLimit>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Work>();
  private readonly reader: ChainReader;
  private readonly cacheTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;

  constructor(opts: BalanceServiceOptions) {
    this.reader = opts.reader;
    this.cacheTtlMs = opts.cacheTtlMs ?? 3_000;
    this.failureTtlMs = opts.failureTtlMs ?? 1_000;
    this.maxCacheEntries = Math.max(1, opts.maxCacheEntries ?? 5_000);
    this.deadlineMs = opts.deadlineMs ?? 3_000;
    this.now = opts.now ?? Date.now;
    for (const id of balanceChainIds(opts.servedChainIds)) {
      this.plans.set(`evm:${id}`, plan(id));
      this.limits.set(
        id,
        new ConcurrencyLimit({
          maxInFlight: opts.maxInFlightPerChain ?? 8,
          maxQueue: opts.maxQueuePerChain ?? 32,
          maxWaitMs: this.deadlineMs,
        }),
      );
    }
  }

  /** True for a served EVM chain with a curated token list (else the request is invalid). */
  serves(chain: ChainKey): boolean {
    return this.plans.has(chain);
  }

  /** True when the chain is served and has a verified RPC endpoint right now. */
  available(chainId: number): boolean {
    return this.plans.has(`evm:${chainId}`) && this.reader.canRead(chainId);
  }

  /**
   * Balances of `owner` (lowercase) on `chain`. Rejects with `ChainReadError` only (`timeout`
   * when `signal` aborts first). Never logs or caches anything outside this process.
   */
  async balances(chain: ChainKey, owner: EvmAddress, signal: AbortSignal): Promise<WalletBalances> {
    const p = this.plans.get(chain);
    if (!p) throw new ChainReadError('rpc_unavailable', 'chain_not_served');
    const key = `${chain}/${owner}`;
    const cached = this.cache.get(key);
    if (cached) {
      const ttl = 'value' in cached ? this.cacheTtlMs : this.failureTtlMs;
      if (this.now() - cached.at < ttl) {
        this.remember(key, cached);
        if ('value' in cached) return cached.value;
        throw cached.error;
      }
      this.cache.delete(key);
    }
    const work = this.inFlight.get(key) ?? this.start(key, chain, p, owner);
    return this.wait(key, work, signal);
  }

  private start(key: string, chain: ChainKey, p: ChainPlan, owner: EvmAddress): Work {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.deadlineMs)]);
    const limit = this.limits.get(p.chainId) as ConcurrencyLimit;
    const work: Work = {
      controller,
      waiters: 0,
      settled: false,
      promise: limit
        .run(() =>
          this.reader.readBalances({ chainId: p.chainId, owner, tokens: p.tokens }, signal),
        )
        .then(
          (read): WalletBalances => {
            const byToken = new Map(p.tokens.map((t, i) => [t, read.tokens[i] ?? null]));
            const value: WalletBalances = {
              chain,
              address: owner,
              blockNumber: read.blockNumber,
              balances: p.order.map((address) => ({
                address,
                balance: address === NATIVE ? read.native : (byToken.get(address) ?? null),
              })),
            };
            this.remember(key, { value, at: this.now() });
            return value;
          },
          (err: unknown): never => {
            if (err instanceof ConcurrencyLimitError) {
              // Busy is a moment, not a fact about the wallet: not cached.
              throw new ChainReadError('rpc_unavailable', 'busy');
            }
            // Abandoned by every caller: nothing to remember.
            if (err instanceof ChainReadError && !controller.signal.aborted) {
              this.remember(key, { error: err, at: this.now() });
            }
            throw err;
          },
        )
        .finally(() => {
          work.settled = true;
          if (this.inFlight.get(key) === work) this.inFlight.delete(key);
        }),
    };
    this.inFlight.set(key, work);
    return work;
  }

  /** Waits for shared work under this caller's signal; the last caller to leave aborts it. */
  private wait(key: string, work: Work, signal: AbortSignal): Promise<WalletBalances> {
    work.waiters++;
    return new Promise<WalletBalances>((resolve, reject) => {
      let left = false;
      const leave = (): void => {
        if (left) return;
        left = true;
        signal.removeEventListener('abort', onAbort);
        work.waiters--;
        if (work.waiters === 0 && !work.settled) {
          // Nobody wants the result any more: stop the RPC calls, and let the next request
          // start fresh work instead of joining an aborted one.
          if (this.inFlight.get(key) === work) this.inFlight.delete(key);
          work.controller.abort();
        }
      };
      const onAbort = (): void => {
        leave();
        reject(new ChainReadError('timeout', 'deadline'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      work.promise.then(
        (value) => {
          leave();
          resolve(value);
        },
        (err: unknown) => {
          leave();
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Inserts or refreshes an entry as most recently used, evicting the least recently used. */
  private remember(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    const oldest = this.cache.keys().next();
    if (this.cache.size >= this.maxCacheEntries && !oldest.done) this.cache.delete(oldest.value);
    this.cache.set(key, entry);
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BaseError,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  ExecutionRevertedError,
  fallback,
  http,
  HttpRequestError,
  parseAbi,
  TimeoutError,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { arbitrum, base, mainnet } from 'viem/chains';
import {
  ChainReadError,
  type BalancesRead,
  type BalancesRequest,
  type ChainReader,
  type EvmAddress,
} from '../../ports/chain-reader.js';

/**
 * Balance reads over JSON-RPC with viem (ADR 0009).
 *
 * - Every chain has one or more endpoints behind viem's `fallback` transport: an endpoint that
 *   errors or times out hands the request to the next one; deterministic errors (a revert) are
 *   not retried. Optional ranking (viem `rank`) re-orders endpoints by sampled latency and
 *   stability.
 * - An endpoint serves nothing until it has answered `eth_chainId` with its configured chain.
 *   One that answers another chain is dropped for the life of the process; one that cannot be
 *   reached is asked again later. Every balance read also checks `block.chainid` inside the
 *   same `eth_call`.
 * - All balances come from one block: the block number is read first, then one Multicall3
 *   `aggregate3` call at that block reads the chain ID, the block timestamp, the native balance
 *   and every `balanceOf`. Per-call failures are allowed, so a reverting token is null.
 * - Redirects are never followed (`redirect: 'error'` on every request): a 3xx would otherwise
 *   re-send the request, owner address included, to a host nobody configured, and serve its
 *   answer without a chain ID proof.
 * - Nothing it logs or throws contains a URL, provider text or the owner address: errors are
 *   reduced to a class name, an HTTP status and a JSON-RPC code.
 */

/** Multicall3 at its canonical address (https://github.com/mds1/multicall). */
export const MULTICALL3: EvmAddress = '0xca11bde05977b3631167028862be2a173976ca11';

const MULTICALL3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getChainId() view returns (uint256 chainid)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);

/**
 * Chains whose viem definition lists Multicall3 at the canonical address. A chain without it is
 * read with individual calls pinned to the same block (slower, same consistency).
 */
export const MULTICALL3_CHAINS: ReadonlySet<number> = new Set(
  [mainnet, base, arbitrum]
    .filter((c) => c.contracts.multicall3.address.toLowerCase() === MULTICALL3)
    .map((c) => c.id),
);

/** Block numbers beyond this are absurd for any chain (2^53, still exact as a JS number). */
const MAX_BLOCK_NUMBER = 2n ** 53n;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;

export interface RpcEndpointConfig {
  url: string;
  /** Non-secret name for logs, e.g. `RPC_URLS_EVM_1[0]`. Never the URL. */
  label: string;
}

/** A structured, non-secret log line. */
export interface ReaderLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ViemChainReaderOptions {
  /** Endpoints per numeric chain ID, in preference order. */
  endpoints: ReadonlyMap<number, readonly RpcEndpointConfig[]>;
  /** Per JSON-RPC request, per endpoint (default 1500 ms; 0 = only the caller's deadline). */
  requestTimeoutMs?: number;
  /** Retries of a whole fallback pass on transient errors (default 1). */
  retryCount?: number;
  /** Base delay between retries, doubled each time (default 100 ms). */
  retryDelayMs?: number;
  /** viem endpoint ranking: every endpoint sampled every `intervalMs` (last 10 samples). */
  rank?: false | { intervalMs: number };
  /**
   * Timeout of the one-off `eth_chainId` proof (default 5000 ms): longer than a read, because the
   * first request to a host also pays for DNS and the TLS handshake.
   */
  verifyTimeoutMs?: number;
  /** An unreachable endpoint is asked for its chain ID again after this (default 10 s). */
  reverifyAfterMs?: number;
  /** A block older than this is stale (default 300 s). */
  maxBlockAgeSeconds?: number;
  /** A block this far in the future is refused (default 60 s). */
  maxClockSkewSeconds?: number;
  /** A block this much older than the newest one seen is refused (default 30 s). */
  maxRewindSeconds?: number;
  /** The newest block seen is forgotten after this, so one bad answer cannot block a chain. */
  highWaterTtlMs?: number;
  /**
   * An endpoint that answers a read for another chain is dropped for this long, doubled on
   * every repeat (default 60 s), up to `maxMismatchPenaltyMs` (default 30 min). Then it must
   * prove its chain again.
   */
  mismatchPenaltyMs?: number;
  maxMismatchPenaltyMs?: number;
  /** Largest RPC response body (default 256 KiB). */
  maxResponseBytes?: number;
  /** Chains to read with Multicall3 (default `MULTICALL3_CHAINS`). */
  multicallChains?: ReadonlySet<number>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: ReaderLog;
}

/**
 * `pending`: not proved yet (or unreachable); `verified`: serves reads; `mismatch`: reported
 * another chain to `eth_chainId`, dropped until restart; `penalized`: answered a read for
 * another chain, dropped until `penaltyUntil`, then proved again.
 */
type EndpointStatus = 'pending' | 'verified' | 'mismatch' | 'penalized';

interface Endpoint {
  readonly url: string;
  readonly label: string;
  status: EndpointStatus;
  /** When the chain ID was last asked (ms); 0 = never. */
  checkedAt: number;
  checking?: Promise<void> | undefined;
  /** Reads answered for another chain so far. */
  strikes: number;
  penaltyUntil: number;
}

/** Per read: the caller's signal, and which endpoint answered each JSON-RPC method. */
interface ReadContext {
  signal: AbortSignal;
  served: { method: string; ep: Endpoint }[];
}

interface HighWater {
  block: bigint;
  timestamp: bigint;
  at: number;
}

interface ChainState {
  readonly chainId: number;
  readonly endpoints: readonly Endpoint[];
  readonly client: PublicClient;
  readonly multicall: boolean;
  highWater?: HighWater | undefined;
}

/** Non-secret description of an error: class name, HTTP status, JSON-RPC code. No message. */
export function describeError(err: unknown): { error: string; status?: number; code?: number } {
  const name =
    err instanceof Error
      ? err.name
      : typeof err === 'object' && err !== null
        ? 'object'
        : typeof err;
  const out: { error: string; status?: number; code?: number } = { error: name.slice(0, 64) };
  if (err instanceof BaseError) {
    const http = err.walk((e) => e instanceof HttpRequestError);
    if (http instanceof HttpRequestError && http.status !== undefined) out.status = http.status;
    const coded = err.walk((e) => typeof (e as { code?: unknown }).code === 'number');
    const code = (coded as { code?: unknown } | null)?.code;
    if (typeof code === 'number') out.code = code;
  }
  return out;
}

/** True when an RPC error is an execution revert (deterministic: the token call itself failed). */
function isRevert(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk((e) => {
      if ((e as { code?: unknown }).code === ExecutionRevertedError.code) return true;
      const details = (e as { details?: unknown }).details;
      return typeof details === 'string' && ExecutionRevertedError.nodeMessage.test(details);
    }) !== null
  );
}

/** True when every attempt timed out (viem's per-request timeout). */
function hasTimeout(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof TimeoutError) !== null;
}

/**
 * A JSON-RPC quantity as a bigint, or a `ChainReadError` for anything else. At most 64 hex
 * digits, so never above 2^256 - 1.
 */
function quantity(value: unknown, reason: string): bigint {
  if (typeof value !== 'string' || value.length > 66 || !QUANTITY.test(value)) {
    throw new ChainReadError('rpc_unavailable', reason);
  }
  return BigInt(value);
}

/**
 * An ABI `uint256` return: exactly one 32-byte word, else null. 64 hex digits cannot exceed
 * 2^256 - 1, so an absurd value is refused by its length.
 */
function uint256Word(data: Hex): bigint | null {
  return /^0x[0-9a-fA-F]{64}$/.test(data) ? BigInt(data) : null;
}

/** Thrown into viem when an endpoint has not proved its chain; viem moves to the next one. */
class EndpointNotVerifiedError extends Error {
  override readonly name = 'EndpointNotVerifiedError';
}

/** Thrown into viem when an endpoint answers with a redirect; viem moves to the next one. */
class EndpointRedirectError extends Error {
  override readonly name = 'EndpointRedirectError';
  constructor() {
    super('redirect refused');
  }
}

/** Node's fetch with `redirect: 'error'` fails a 3xx with this cause. */
function isRedirectError(err: unknown): boolean {
  const cause = (err as { cause?: { message?: unknown } } | null)?.cause;
  return err instanceof TypeError && /redirect/i.test(String(cause?.message));
}

/** The JSON-RPC method of a request body viem built (a single request, never a batch). */
function methodOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body)) as { method?: unknown };
  return String(body.method);
}

export class ViemChainReader implements ChainReader {
  private readonly chains = new Map<number, ChainState>();
  private readonly requestTimeoutMs: number;
  private readonly reverifyAfterMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly maxBlockAgeSeconds: bigint;
  private readonly maxClockSkewSeconds: bigint;
  private readonly maxRewindSeconds: bigint;
  private readonly highWaterTtlMs: number;
  private readonly mismatchPenaltyMs: number;
  private readonly maxMismatchPenaltyMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: ReaderLog | undefined;
  /** The read in progress, visible to every fetch made on its behalf (through viem). */
  private readonly context = new AsyncLocalStorage<ReadContext>();

  constructor(opts: ViemChainReaderOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 1_500;
    this.reverifyAfterMs = opts.reverifyAfterMs ?? 10_000;
    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? 5_000;
    this.maxBlockAgeSeconds = BigInt(opts.maxBlockAgeSeconds ?? 300);
    this.maxClockSkewSeconds = BigInt(opts.maxClockSkewSeconds ?? 60);
    this.maxRewindSeconds = BigInt(opts.maxRewindSeconds ?? 30);
    this.highWaterTtlMs = opts.highWaterTtlMs ?? 60_000;
    this.mismatchPenaltyMs = opts.mismatchPenaltyMs ?? 60_000;
    this.maxMismatchPenaltyMs = opts.maxMismatchPenaltyMs ?? 30 * 60_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 256 * 1024;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    const multicallChains = opts.multicallChains ?? MULTICALL3_CHAINS;

    for (const [chainId, configs] of opts.endpoints) {
      if (configs.length === 0) continue;
      const endpoints: Endpoint[] = configs.map((c) => ({
        url: c.url,
        label: c.label,
        status: 'pending',
        checkedAt: 0,
        strikes: 0,
        penaltyUntil: 0,
      }));
      const transports = endpoints.map((ep) =>
        http(ep.url, {
          fetchFn: this.endpointFetch(chainId, ep, true),
          timeout: this.requestTimeoutMs,
          retryCount: 0,
          maxResponseBodySize: this.maxResponseBytes,
        }),
      );
      const rank = opts.rank
        ? {
            interval: opts.rank.intervalMs,
            sampleCount: 10,
            timeout: this.requestTimeoutMs,
            ping: ({ transport }: { transport: { request: PublicClient['request'] } }) =>
              transport.request({ method: 'eth_blockNumber' }),
          }
        : false;
      const client = createPublicClient({
        transport: fallback(transports, {
          rank,
          retryCount: opts.retryCount ?? 1,
          retryDelay: opts.retryDelayMs ?? 100,
        }),
      });
      this.chains.set(chainId, {
        chainId,
        endpoints,
        client,
        multicall: multicallChains.has(chainId),
      });
    }
  }

  canRead(chainId: number): boolean {
    return this.chains.get(chainId)?.endpoints.some((e) => e.status === 'verified') ?? false;
  }

  /**
   * Asks every endpoint that has not proved its chain for its chain ID (startup, and then
   * periodically). Never rejects.
   */
  async verifyEndpoints(): Promise<void> {
    await Promise.all([...this.chains.values()].map((c) => this.verifyPending(c, true)));
  }

  async readBalances(request: BalancesRequest, signal: AbortSignal): Promise<BalancesRead> {
    const chain = this.chains.get(request.chainId);
    if (!chain) throw new ChainReadError('rpc_unavailable', 'chain_not_configured');
    if (signal.aborted) throw new ChainReadError('timeout', 'aborted');
    if (!this.canRead(chain.chainId)) {
      void this.verifyPending(chain, false);
      throw new ChainReadError('rpc_unavailable', 'no_verified_endpoint');
    }
    const ctx: ReadContext = { signal, served: [] };
    try {
      return await this.context.run(ctx, () => this.read(chain, request, ctx));
    } catch (err: unknown) {
      throw this.failure(chain, err, signal);
    }
  }

  private async read(
    chain: ChainState,
    request: BalancesRequest,
    ctx: ReadContext,
  ): Promise<BalancesRead> {
    const signal = ctx.signal;
    const blockNumber = quantity(
      await chain.client.request({ method: 'eth_blockNumber' }, { signal }),
      'malformed_block_number',
    );
    if (blockNumber === 0n || blockNumber > MAX_BLOCK_NUMBER) {
      throw new ChainReadError('rpc_unavailable', 'implausible_block_number');
    }
    const reading = chain.multicall
      ? this.readMulticall(chain, request, blockNumber, signal)
      : this.readIndividually(chain, request, blockNumber, signal);
    const result = await reading;
    if (result.chainId !== BigInt(chain.chainId)) {
      // The endpoint that answered the chain ID (the eth_call itself with Multicall3) serves
      // another chain: drop it for a while. The others keep serving.
      const method = chain.multicall ? 'eth_call' : 'eth_chainId';
      ctx.served
        .filter((s) => s.method === method)
        .slice(-1)
        .forEach(({ ep }) => this.penalize(chain, ep));
      throw new ChainReadError('rpc_unavailable', 'chain_id_mismatch');
    }
    this.checkBlock(chain, blockNumber, result.timestamp);
    const malformed = result.tokens.filter((t) => t === null).length;
    if (malformed > 0 || result.native === null) {
      this.log?.info(
        { chainId: chain.chainId, failedTokens: malformed, nativeFailed: result.native === null },
        'some balance reads failed',
      );
    }
    return { blockNumber, native: result.native, tokens: result.tokens };
  }

  /** One `eth_call` of Multicall3 `aggregate3` at `blockNumber`. */
  private async readMulticall(
    chain: ChainState,
    request: BalancesRequest,
    blockNumber: bigint,
    signal: AbortSignal,
  ): Promise<RawRead> {
    const own = (functionName: 'getChainId' | 'getCurrentBlockTimestamp') => ({
      target: MULTICALL3,
      allowFailure: false,
      callData: encodeFunctionData({ abi: MULTICALL3_ABI, functionName }),
    });
    const calls = [
      own('getChainId'),
      own('getCurrentBlockTimestamp'),
      {
        target: MULTICALL3,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: MULTICALL3_ABI,
          functionName: 'getEthBalance',
          args: [request.owner],
        }),
      },
      ...request.tokens.map((token) => ({
        target: token,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [request.owner],
        }),
      })),
    ];
    const data = encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [calls],
    });
    const raw = await chain.client.request(
      { method: 'eth_call', params: [{ to: MULTICALL3, data }, toHex(blockNumber)] },
      { signal },
    );
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) {
      throw new ChainReadError('rpc_unavailable', 'malformed_call_result');
    }
    let results: readonly { success: boolean; returnData: Hex }[];
    try {
      results = decodeFunctionResult({
        abi: MULTICALL3_ABI,
        functionName: 'aggregate3',
        data: raw,
      });
    } catch {
      throw new ChainReadError('rpc_unavailable', 'malformed_call_result');
    }
    if (results.length !== calls.length) {
      throw new ChainReadError('rpc_unavailable', 'malformed_call_result');
    }
    const [chainIdResult, timestampResult, nativeResult, ...tokenResults] = results;
    const chainId = chainIdResult?.success ? uint256Word(chainIdResult.returnData) : null;
    const timestamp = timestampResult?.success ? uint256Word(timestampResult.returnData) : null;
    if (chainId === null || timestamp === null) {
      throw new ChainReadError('rpc_unavailable', 'malformed_call_result');
    }
    const value = (r: { success: boolean; returnData: Hex } | undefined): bigint | null =>
      r?.success ? uint256Word(r.returnData) : null;
    return { chainId, timestamp, native: value(nativeResult), tokens: tokenResults.map(value) };
  }

  /**
   * Without Multicall3: one request per balance, all pinned to `blockNumber`, at the cost of
   * N + 3 requests. Weaker than one call: each request may be answered by a different endpoint,
   * so the chain ID and block checks cover the endpoint that answered them, not necessarily the
   * ones that answered the balances (proved endpoints only, all pinned to the same block). A
   * reverting token is null; any other failure fails the read (an outage must not look like
   * empty balances).
   */
  private async readIndividually(
    chain: ChainState,
    request: BalancesRequest,
    blockNumber: bigint,
    signal: AbortSignal,
  ): Promise<RawRead> {
    const at = toHex(blockNumber);
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [request.owner],
    });
    const [chainId, block, native, ...tokens] = await Promise.all([
      chain.client
        .request({ method: 'eth_chainId' }, { signal })
        .then((v) => quantity(v, 'malformed_chain_id')),
      chain.client.request({ method: 'eth_getBlockByNumber', params: [at, false] }, { signal }),
      chain.client
        .request({ method: 'eth_getBalance', params: [request.owner, at] }, { signal })
        .then((v) => quantity(v, 'malformed_balance')),
      ...request.tokens.map((to) =>
        chain.client.request({ method: 'eth_call', params: [{ to, data }, at] }, { signal }).then(
          (v) => (typeof v === 'string' ? uint256Word(v) : null),
          (err: unknown) => {
            if (isRevert(err)) return null;
            throw err;
          },
        ),
      ),
    ]);
    if (
      typeof block !== 'object' ||
      block === null ||
      quantity(block.number, 'malformed_block') !== blockNumber
    ) {
      throw new ChainReadError('rpc_unavailable', 'malformed_block');
    }
    return { chainId, timestamp: quantity(block.timestamp, 'malformed_block'), native, tokens };
  }

  /**
   * Plausibility of the block every balance was read at. A buggy or lagging endpoint is caught;
   * a malicious one can still lie consistently (ADR 0009: balances are display data only).
   */
  private checkBlock(chain: ChainState, block: bigint, timestamp: bigint): void {
    const nowMs = this.now();
    const nowS = BigInt(Math.floor(nowMs / 1000));
    if (timestamp > nowS + this.maxClockSkewSeconds) {
      throw new ChainReadError('rpc_unavailable', 'block_in_future');
    }
    if (timestamp + this.maxBlockAgeSeconds < nowS) {
      throw new ChainReadError('rpc_unavailable', 'stale_block');
    }
    let hw = chain.highWater;
    if (hw && nowMs - hw.at > this.highWaterTtlMs) hw = chain.highWater = undefined;
    if (hw) {
      // Rewound well behind the newest block seen, or an older block with a much later time.
      if (timestamp + this.maxRewindSeconds < hw.timestamp) {
        throw new ChainReadError('rpc_unavailable', 'block_rewound');
      }
      if (block < hw.block && timestamp > hw.timestamp + this.maxRewindSeconds) {
        throw new ChainReadError('rpc_unavailable', 'inconsistent_block');
      }
    }
    if (!hw || block >= hw.block) chain.highWater = { block, timestamp, at: nowMs };
  }

  /** Maps any failure to a `ChainReadError`, logging a non-secret description. */
  private failure(chain: ChainState, err: unknown, signal: AbortSignal): ChainReadError {
    if (signal.aborted) return new ChainReadError('timeout', 'deadline');
    if (err instanceof ChainReadError) {
      this.log?.warn({ chainId: chain.chainId, reason: err.reason }, 'balance read refused');
      return err;
    }
    const code = hasTimeout(err) ? 'timeout' : 'rpc_unavailable';
    this.log?.warn({ chainId: chain.chainId, ...describeError(err) }, 'balance read failed');
    return new ChainReadError(code, code === 'timeout' ? 'rpc_timeout' : 'rpc_error');
  }

  /** Drops an endpoint that answered a read for another chain, with an exponential penalty. */
  private penalize(chain: ChainState, ep: Endpoint): void {
    ep.strikes += 1;
    const penaltyMs = Math.min(
      this.mismatchPenaltyMs * 2 ** (ep.strikes - 1),
      this.maxMismatchPenaltyMs,
    );
    ep.status = 'penalized';
    ep.penaltyUntil = this.now() + penaltyMs;
    this.log?.error(
      { chainId: chain.chainId, endpoint: ep.label, penaltyMs },
      'RPC answered a balance read for another chain; endpoint dropped for a while',
    );
  }

  /**
   * The fetch of one endpoint. Never follows a redirect. With `gate` (reads, ranking pings) it
   * refuses until the endpoint has proved its chain, honours the caller's signal and records
   * which endpoint answered which method.
   */
  private endpointFetch(chainId: number, ep: Endpoint, gate: boolean): typeof fetch {
    return async (input, init) => {
      if (gate && ep.status !== 'verified') throw new EndpointNotVerifiedError();
      const ctx = gate ? this.context.getStore() : undefined;
      const caller = ctx?.signal;
      const signal =
        caller && init?.signal ? AbortSignal.any([caller, init.signal]) : (caller ?? init?.signal);
      let res: Response;
      try {
        res = await this.fetch(input, { ...init, signal: signal ?? null, redirect: 'error' });
      } catch (err: unknown) {
        if (isRedirectError(err)) throw this.redirected(chainId, ep);
        throw err;
      }
      // A fetch that ignored `redirect: 'error'` (defence in depth): a 3xx is still refused.
      if (res.status >= 300 && res.status < 400) throw this.redirected(chainId, ep);
      ctx?.served.push({ method: methodOf(init), ep });
      return res;
    };
  }

  private redirected(chainId: number, ep: Endpoint): EndpointRedirectError {
    this.log?.warn(
      { chainId, endpoint: ep.label, reason: 'redirect' },
      'RPC endpoint answered with a redirect; refused',
    );
    return new EndpointRedirectError();
  }

  private verifyPending(chain: ChainState, force: boolean): Promise<void> {
    const now = this.now();
    const due = chain.endpoints.filter(
      (ep) =>
        (ep.status === 'pending' || (ep.status === 'penalized' && now >= ep.penaltyUntil)) &&
        !ep.checking &&
        (force || ep.checkedAt === 0 || now - ep.checkedAt >= this.reverifyAfterMs),
    );
    return Promise.all(
      due.map((ep) => {
        ep.checking = this.verify(chain, ep).finally(() => (ep.checking = undefined));
        return ep.checking;
      }),
    ).then(() => undefined);
  }

  /** `eth_chainId` straight to one endpoint (no fallback), with one attempt and a timeout. */
  private async verify(chain: ChainState, ep: Endpoint): Promise<void> {
    ep.checkedAt = this.now();
    const client = createPublicClient({
      transport: http(ep.url, {
        fetchFn: this.endpointFetch(chain.chainId, ep, false),
        timeout: this.verifyTimeoutMs,
        retryCount: 0,
        maxResponseBodySize: 4 * 1024,
      }),
    });
    const where = { chainId: chain.chainId, endpoint: ep.label };
    try {
      const reported = await client.request({ method: 'eth_chainId' });
      if (typeof reported !== 'string' || !QUANTITY.test(reported)) {
        this.log?.warn(where, 'RPC endpoint returned a malformed chain ID; will retry');
        return;
      }
      if (BigInt(reported) === BigInt(chain.chainId)) {
        ep.status = 'verified';
        this.log?.info(where, 'RPC endpoint verified');
      } else {
        // A mis-pointed endpoint must never serve another chain's balances: dropped until restart.
        ep.status = 'mismatch';
        this.log?.error(where, 'RPC endpoint serves another chain; dropped (check its env var)');
      }
    } catch (err: unknown) {
      this.log?.warn({ ...where, ...describeError(err) }, 'RPC endpoint unreachable; will retry');
    }
  }
}

interface RawRead {
  chainId: bigint;
  timestamp: bigint;
  native: bigint | null;
  tokens: (bigint | null)[];
}

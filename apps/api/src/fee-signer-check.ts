import type { TypedDataDefinition } from 'viem';
import type { RoutePolicy } from './domain/route-policy.js';
import { EIP712_NAME, EIP712_VERSION } from './domain/swap-quote.js';
import { ChainReadError, type EvmAddress } from './ports/chain-reader.js';
import type { FeeWrapperReader, FeeWrapperState } from './ports/fee-wrapper-reader.js';
import { SigningUnavailableError, type QuoteSigner } from './ports/quote-signer.js';
import { canSignChain } from './signing-policy.js';

/**
 * The on-chain signer check (ADR 0005 follow-up; ADR 0013 work breakdown row 5).
 *
 * For every chain the API signs quotes for, the deployed FeeWrapper must have code, its
 * `feeSigner()` must be the configured signer, and its EIP-712 domain must be
 * `Ranvier FeeWrapper` version `1` for that chain ID and that wrapper address. Otherwise every
 * quote the API signs there would revert on chain (`InvalidSignature`), or would be signed for a
 * contract nobody configured.
 *
 * - **Startup: fail closed.** Every chain must match before the API listens. A chain whose
 *   wrapper cannot be read (no endpoint, every endpoint unreachable, a malformed answer) is
 *   retried a few times (`startupAttempts`, `retryDelayMs`), with the endpoints asked to prove
 *   their chain again in between; then startup is refused. A mismatch is refused at once.
 * - **Runtime: cached, refreshed every `refreshIntervalMs` (default 10 minutes).** A confirmed
 *   mismatch stops signing on that chain (`503 signing_unavailable`) until a later check matches
 *   again, and is logged at error level. A failed read keeps the last confirmed result and logs a
 *   warning. Reasons: `feeSigner` changes only through the admin multisig behind its timelock
 *   (hours, not seconds), so a ten-minute lag is enough to catch a rotation; and the wrapper
 *   verifies every signature on chain, so a stale "matches" can only cost a reverted
 *   transaction, never funds. Stopping signing on a transient RPC failure would make quoting
 *   depend on RPC health, which ADR 0009 keeps apart ("quoting is unaffected").
 *
 * The reads go through the balance reader's endpoints (`RPC_URLS_EVM_<chainId>`, else the public
 * development defaults), with its chain ID proof, timeouts and redirect refusal (ADR 0009).
 */

export type WrapperMismatch =
  | 'no_code'
  | 'no_fee_signer'
  | 'fee_signer_differs'
  | 'no_domain'
  | 'domain_name'
  | 'domain_version'
  | 'domain_chain_id'
  | 'domain_contract';

export interface WrapperExpectation {
  chainId: number;
  /** Any letter case. */
  feeWrapper: string;
  /** The configured signer's address, any letter case. */
  signer: string;
}

/** The first way `state` disagrees with `expected`, or undefined when it matches. */
export function wrapperMismatch(
  state: FeeWrapperState,
  expected: WrapperExpectation,
): WrapperMismatch | undefined {
  if (!state.hasCode) return 'no_code';
  if (state.feeSigner === null) return 'no_fee_signer';
  if (state.feeSigner !== expected.signer.toLowerCase()) return 'fee_signer_differs';
  const d = state.domain;
  if (d === null) return 'no_domain';
  if (d.name !== EIP712_NAME) return 'domain_name';
  if (d.version !== EIP712_VERSION) return 'domain_version';
  if (d.chainId !== BigInt(expected.chainId)) return 'domain_chain_id';
  if (d.verifyingContract !== expected.feeWrapper.toLowerCase()) return 'domain_contract';
  return undefined;
}

/** The chains a signer will really sign for: `canSignChain` at startup (ADR 0005). */
export function signingChainIds(
  quotedChainIds: readonly number[],
  signer: QuoteSigner,
  policy: RoutePolicy,
): number[] {
  return [...new Set(quotedChainIds)].filter((id) => canSignChain(signer, policy, id));
}

/** Startup refused: the chain disagrees with the configuration, or could not be read. */
export class FeeSignerCheckError extends Error {
  override readonly name = 'FeeSignerCheckError';
}

/** A structured, non-secret log line (chain IDs and fixed reasons only, never a URL). */
export interface CheckLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface FeeSignerMonitorOptions {
  reader: FeeWrapperReader;
  /** The chains to check: `signingChainIds(...)`. */
  chainIds: readonly number[];
  feeWrapper: string;
  /** The configured signer address. */
  signer: string;
  /** Deadline of one chain's read (default 10 s). */
  readTimeoutMs?: number;
  /** Reads at startup before refusing (default 3). */
  startupAttempts?: number;
  /** Pause between startup attempts (default 2 s). */
  retryDelayMs?: number;
  /** Runtime re-check interval (default 10 minutes). */
  refreshIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: CheckLog;
}

type ChainCheck =
  { ok: true } | { ok: false; reason: WrapperMismatch | 'read_failed'; detail: string };

export class FeeSignerMonitor {
  private readonly reader: FeeWrapperReader;
  private readonly chains: ReadonlySet<number>;
  private readonly expectedSigner: string;
  private readonly feeWrapper: string;
  private readonly readTimeoutMs: number;
  private readonly startupAttempts: number;
  private readonly retryDelayMs: number;
  private readonly refreshIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: CheckLog | undefined;
  /** The last confirmed result per chain: true = matches. Absent = never confirmed. */
  private readonly confirmed = new Map<number, boolean>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: FeeSignerMonitorOptions) {
    this.reader = opts.reader;
    this.chains = new Set(opts.chainIds);
    this.expectedSigner = opts.signer;
    this.feeWrapper = opts.feeWrapper;
    this.readTimeoutMs = opts.readTimeoutMs ?? 10_000;
    this.startupAttempts = Math.max(1, opts.startupAttempts ?? 3);
    this.retryDelayMs = opts.retryDelayMs ?? 2_000;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 10 * 60_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log;
  }

  /** The chains this monitor checks, in no particular order. */
  get chainIds(): number[] {
    return [...this.chains];
  }

  /** True when the last confirmed check of a monitored chain matched. */
  matches(chainId: number): boolean {
    return this.confirmed.get(chainId) === true;
  }

  private async check(chainId: number): Promise<ChainCheck> {
    let state: FeeWrapperState;
    try {
      state = await this.reader.readFeeWrapper(
        chainId,
        this.feeWrapper.toLowerCase() as EvmAddress,
        AbortSignal.timeout(this.readTimeoutMs),
      );
    } catch (err: unknown) {
      // ChainReadError carries a fixed, non-secret reason; anything else is named only.
      const detail =
        err instanceof ChainReadError ? err.reason : err instanceof Error ? err.name : 'unknown';
      return { ok: false, reason: 'read_failed', detail };
    }
    const reason = wrapperMismatch(state, {
      chainId,
      feeWrapper: this.feeWrapper,
      signer: this.expectedSigner,
    });
    if (reason === undefined) return { ok: true };
    const onChain = reason === 'fee_signer_differs' ? ` (feeSigner() is ${state.feeSigner})` : '';
    return { ok: false, reason, detail: `${reason}${onChain} at block ${state.blockNumber}` };
  }

  /**
   * Every monitored chain must match, or this throws `FeeSignerCheckError` (fail closed). Reads
   * that fail are retried; a mismatch is not.
   */
  async verifyAtStartup(): Promise<void> {
    let pending = [...this.chains];
    for (let attempt = 1; pending.length > 0; attempt++) {
      const failures = new Map<number, string>();
      for (const chainId of pending) {
        const result = await this.check(chainId);
        if (result.ok) {
          this.confirmed.set(chainId, true);
          this.log?.info({ chainId }, 'FeeWrapper feeSigner matches the signer');
          continue;
        }
        if (result.reason !== 'read_failed') {
          this.confirmed.set(chainId, false);
          throw new FeeSignerCheckError(
            `FeeWrapper ${this.feeWrapper} on chain ${chainId} does not match the configured ` +
              `signer ${this.expectedSigner}: ${result.detail}. Refusing to start: every quote ` +
              'signed for this chain would be refused on chain (ADR 0005).',
          );
        }
        failures.set(chainId, result.detail);
      }
      pending = [...failures.keys()];
      if (pending.length === 0) return;
      if (attempt >= this.startupAttempts) {
        throw new FeeSignerCheckError(
          `Could not read the FeeWrapper on chain(s) ${[...failures]
            .map(([id, why]) => `${id} (${why})`)
            .join(', ')} to compare feeSigner() with the configured signer. Refusing to start ` +
            '(fail closed): check RPC_URLS_EVM_<chainId> for these chains.',
        );
      }
      this.log?.warn(
        { chains: pending, attempt },
        'FeeWrapper read failed at startup; proving endpoints again and retrying',
      );
      await this.reader.verifyEndpoints();
      await this.sleep(this.retryDelayMs);
    }
  }

  /**
   * One runtime re-check of every monitored chain. A confirmed mismatch stops signing on that
   * chain; a failed read keeps the last confirmed result. Never rejects.
   */
  async refresh(): Promise<void> {
    for (const chainId of this.chains) {
      const result = await this.check(chainId);
      const before = this.confirmed.get(chainId);
      if (result.ok) {
        this.confirmed.set(chainId, true);
        if (before === false)
          this.log?.info({ chainId }, 'FeeWrapper matches again; signing resumed');
      } else if (result.reason === 'read_failed') {
        this.log?.warn(
          { chainId, reason: result.detail },
          'FeeWrapper re-check failed; keeping the last confirmed result',
        );
      } else {
        this.confirmed.set(chainId, false);
        this.log?.error(
          { chainId, reason: result.reason },
          'FeeWrapper no longer matches the signer; signing stopped on this chain',
        );
      }
    }
  }

  /** Starts the periodic re-check (the timer is unref'd). */
  start(): void {
    if (this.timer || this.chains.size === 0) return;
    this.timer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * `inner`, refusing every monitored chain whose last confirmed check did not match. Kind and
   * address are unchanged, and chains outside the monitored set keep the inner signer's answer.
   */
  gate(inner: QuoteSigner): QuoteSigner {
    const blocked = (chainId: number): boolean =>
      this.chains.has(chainId) && !this.matches(chainId);
    return {
      kind: inner.kind,
      address: inner.address,
      canSign: (chainId) => !blocked(chainId) && inner.canSign(chainId),
      signTypedData: (typedData: TypedDataDefinition) => {
        const chainId = Number(typedData.domain?.chainId);
        if (blocked(chainId)) {
          return Promise.reject(
            new SigningUnavailableError(
              'integrity',
              `FeeWrapper on chain ${chainId} does not match the signer`,
            ),
          );
        }
        return inner.signTypedData(typedData);
      },
    };
  }
}

/**
 * Reads account state from an EVM chain through our own RPC providers (ADR 0009). The browser
 * never talks to an RPC provider; it asks the API, which asks this port.
 *
 * Results are DISPLAY data. They are never used for fee, route-vetting or signing decisions: the
 * fee wrapper's on-chain checks govern money.
 */

export type EvmAddress = `0x${string}`;

export interface BalancesRequest {
  /** Numeric EVM chain ID. */
  chainId: number;
  /** Lowercase 20-byte account address. */
  owner: EvmAddress;
  /** Lowercase ERC-20 token addresses; a bounded, curated list (never client-supplied). */
  tokens: readonly EvmAddress[];
}

export interface BalancesRead {
  /** The one block every balance was read at. */
  blockNumber: bigint;
  /** Native coin balance in base units; null if that one read failed. */
  native: bigint | null;
  /**
   * ERC-20 `balanceOf(owner)` in base units, in the order of `BalancesRequest.tokens`. A token
   * whose call reverted or returned malformed data is null; the rest are still returned.
   */
  tokens: readonly (bigint | null)[];
}

/**
 * Stable failure codes. `rpc_unavailable`: no healthy endpoint, every endpoint failed, or the
 * data failed validation. `timeout`: the caller's deadline passed or every attempt timed out.
 * Messages never contain a URL, provider text or the owner address.
 */
export type ChainReadErrorCode = 'rpc_unavailable' | 'timeout';

export class ChainReadError extends Error {
  override readonly name = 'ChainReadError';
  constructor(
    readonly code: ChainReadErrorCode,
    /** A short, fixed, non-secret reason for logs (e.g. `chain_id_mismatch`). */
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
  }
}

export interface ChainReader {
  /** True when at least one endpoint of the chain has proved it serves that chain. */
  canRead(chainId: number): boolean;
  /**
   * Native and ERC-20 balances at one consistent block. Rejects only with `ChainReadError`.
   * `signal` aborts every outstanding RPC request.
   */
  readBalances(request: BalancesRequest, signal: AbortSignal): Promise<BalancesRead>;
}

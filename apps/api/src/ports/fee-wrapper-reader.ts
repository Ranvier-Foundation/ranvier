import type { EvmAddress } from './chain-reader.js';

/**
 * Reads the deployed FeeWrapper's signing configuration from a chain (ADR 0005, "On-chain signer
 * check"), through the same RPC endpoints, chain ID proof and redirect refusal as balance reads
 * (ADR 0009). Used only to refuse signing when the chain disagrees with the configured signer;
 * never to decide an amount.
 */
export interface FeeWrapperState {
  /** The one block every value was read at. */
  blockNumber: bigint;
  /** True when the address holds contract code at that block. */
  hasCode: boolean;
  /** `feeSigner()`, lowercase; null when the call reverted or returned malformed data. */
  feeSigner: EvmAddress | null;
  /** `eip712Domain()` (EIP-5267); null when the call reverted or returned malformed data. */
  domain: {
    name: string;
    version: string;
    chainId: bigint;
    /** Lowercase. */
    verifyingContract: EvmAddress;
  } | null;
}

export interface FeeWrapperReader {
  /** True when at least one endpoint of the chain has proved it serves that chain. */
  canRead(chainId: number): boolean;
  /** Asks every endpoint that has not proved its chain for its chain ID. Never rejects. */
  verifyEndpoints(): Promise<void>;
  /** Rejects only with `ChainReadError` (`timeout` when `signal` aborts first). */
  readFeeWrapper(
    chainId: number,
    wrapper: EvmAddress,
    signal: AbortSignal,
  ): Promise<FeeWrapperState>;
}

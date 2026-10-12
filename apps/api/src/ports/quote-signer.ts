import type { Hex, TypedDataDefinition } from 'viem';

/**
 * `local-key`: a key from the environment, for development and testnets only.
 * `kms`: a key held in a cloud KMS/HSM; the only kind that may sign for a mainnet.
 */
export type SignerKind = 'local-key' | 'kms';

/**
 * Signs fee-wrapper quotes (EIP-712). Production keys live in a cloud KMS/HSM and are
 * never on a server disk (spec section 4); local keys are for development and testnets.
 */
export interface QuoteSigner {
  readonly kind: SignerKind;
  readonly address: Hex;
  /** False for chains this signer must never sign for (e.g. mainnets for a local key). */
  canSign(chainId: number): boolean;
  /**
   * Throws for a chain `canSign` refuses. Throws `SigningUnavailableError` when the signer
   * cannot sign right now (busy, timed out, upstream failure, or a signature that failed
   * self-verification); the HTTP layer answers 503 `signing_unavailable`.
   */
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}

/**
 * - `busy`: the in-memory concurrency limit is full; failed fast without calling the KMS.
 * - `timeout`: the KMS did not answer in time (after the allowed retry).
 * - `upstream`: the KMS refused or failed (throttling, access denied, disabled key, ...).
 * - `integrity`: the KMS answered, but the signature did not verify against the signer's
 *   address. Fails closed; this should never happen and must be alerted on.
 */
export type SigningFailure = 'busy' | 'timeout' | 'upstream' | 'integrity';

/** A signer could not produce a signature. The message is for server logs, never clients. */
export class SigningUnavailableError extends Error {
  override readonly name = 'SigningUnavailableError';

  constructor(
    readonly reason: SigningFailure,
    message: string,
  ) {
    super(message);
  }
}

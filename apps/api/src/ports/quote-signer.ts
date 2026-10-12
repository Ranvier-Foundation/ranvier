import type { Hex, TypedDataDefinition } from 'viem';

/**
 * Signs fee-wrapper quotes (EIP-712). Production keys live in a cloud KMS/HSM and are
 * never on a server disk (spec section 4); local keys are for development and testnets.
 */
export interface QuoteSigner {
  readonly address: Hex;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}

import type { Hex, TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { QuoteSigner } from '../../ports/quote-signer.js';

/**
 * Signs with a private key from the environment. Development and testnets only:
 * production fee-signing keys must live in a KMS/HSM (spec section 4).
 */
export class LocalKeySigner implements QuoteSigner {
  private readonly account;
  readonly address: Hex;

  constructor(privateKey: Hex, env: string | undefined = process.env.NODE_ENV) {
    if (env === 'production') {
      throw new Error('LocalKeySigner must not be used in production; use a KMS signer');
    }
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  signTypedData(typedData: TypedDataDefinition): Promise<Hex> {
    return this.account.signTypedData(typedData);
  }
}

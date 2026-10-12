import { CHAINS } from '@ranvier/chains';
import type { Hex, TypedDataDefinition } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { QuoteSigner } from '../../ports/quote-signer.js';
import { TRUSTED_ROUTERS, ZEROX_SETTLERS } from '../../trusted-routers.js';

/**
 * The only chains a key from the environment may ever sign for: known testnets and local
 * chains. `LOCAL_SIGNER_CHAIN_IDS` may narrow this set, never extend it.
 */
export const LOCAL_SIGNER_DEFAULT_CHAINS: readonly number[] = [
  84532, // Base Sepolia
  11155111, // Sepolia
  421614, // Arbitrum Sepolia
  31337, // Anvil / Hardhat (including a forked mainnet run under its own chain ID)
];

const LOCAL_SIGNER_ALLOWED: ReadonlySet<number> = new Set(LOCAL_SIGNER_DEFAULT_CHAINS);

/**
 * Chains a local key may never sign for: well-known mainnets, every EVM chain in the
 * registry, and every chain with trusted routers or Settlers (all live chains). A second line
 * of defence behind the allowlist; a test checks the two sets never overlap.
 */
export const NEVER_LOCAL_CHAINS: ReadonlySet<number> = new Set([
  1, // Ethereum
  10, // OP Mainnet
  56, // BNB Smart Chain
  137, // Polygon
  8453, // Base
  42161, // Arbitrum One
  43114, // Avalanche C-Chain
  ...CHAINS.flatMap((c) => (c.family === 'evm' ? [Number(c.key.slice('evm:'.length))] : [])),
  ...Object.keys(ZEROX_SETTLERS).map(Number),
  ...TRUSTED_ROUTERS.keys(),
]);

export interface LocalKeySignerOptions {
  /** Chains this key may sign for. Defaults to `LOCAL_SIGNER_DEFAULT_CHAINS`. */
  allowedChainIds?: readonly number[];
  nodeEnv?: string | undefined;
}

/**
 * Signs with a private key from the environment. Development, testnets and local forks only:
 * production fee-signing keys must live in a KMS/HSM (spec section 4, ADR 0004). It refuses
 * to start under NODE_ENV=production or with a mainnet in its allowlist, and refuses to sign
 * for any chain outside its allowlist.
 */
export class LocalKeySigner implements QuoteSigner {
  private readonly account;
  private readonly allowed: ReadonlySet<number>;
  readonly kind = 'local-key' as const;
  readonly address: Hex;

  constructor(privateKey: Hex, opts: LocalKeySignerOptions = {}) {
    const nodeEnv = 'nodeEnv' in opts ? opts.nodeEnv : process.env.NODE_ENV;
    if (nodeEnv?.trim().toLowerCase() === 'production') {
      throw new Error('LocalKeySigner must not be used in production; use a KMS signer');
    }
    const allowed = opts.allowedChainIds ?? LOCAL_SIGNER_DEFAULT_CHAINS;
    const forbidden = allowed.filter(
      (id) => !LOCAL_SIGNER_ALLOWED.has(id) || NEVER_LOCAL_CHAINS.has(id),
    );
    if (forbidden.length > 0) {
      throw new Error(
        `LocalKeySigner may not sign for chain(s) ${forbidden.join(', ')}: only known testnets ` +
          `and local chains (${LOCAL_SIGNER_DEFAULT_CHAINS.join(', ')}) are allowed. Use a KMS ` +
          'signer, or a local fork (chain ID 31337) for end-to-end tests',
      );
    }
    this.allowed = new Set(allowed);
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  canSign(chainId: number): boolean {
    return this.allowed.has(chainId) && !NEVER_LOCAL_CHAINS.has(chainId);
  }

  signTypedData(typedData: TypedDataDefinition): Promise<Hex> {
    const chainId = typedData.domain?.chainId;
    if (chainId === undefined || !this.canSign(Number(chainId))) {
      return Promise.reject(new Error(`LocalKeySigner refuses chain ${String(chainId)}`));
    }
    return this.account.signTypedData(typedData);
  }
}

/**
 * Startup check: every chain the API would sign for must be one the local key may sign for.
 * Throws a message naming the offending chains and the fix.
 */
export function assertLocalSigningChains(
  signingChainIds: readonly number[],
  signer: QuoteSigner,
): void {
  const refused = signingChainIds.filter((id) => !signer.canSign(id));
  if (refused.length > 0) {
    throw new Error(
      `QUOTE_SIGNER_PRIVATE_KEY is set but ZEROX_CHAIN_IDS includes chain(s) ${refused.join(', ')} ` +
        'that a local key must not sign for. Use testnet or local fork chain IDs ' +
        `(${LOCAL_SIGNER_DEFAULT_CHAINS.join(', ')}), or unset the key (production uses a KMS signer).`,
    );
  }
}

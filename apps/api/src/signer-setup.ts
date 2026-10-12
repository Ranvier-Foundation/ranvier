import type { Hex } from 'viem';
import { errorMessage, KmsSigner, type KmsTransport } from './adapters/signers/kms.js';
import {
  assertLocalSigningChains,
  LOCAL_SIGNER_DEFAULT_CHAINS,
  LocalKeySigner,
} from './adapters/signers/local-key.js';
import { KMS_KEY_ARN, type Config } from './config.js';
import type { RoutePolicy } from './domain/route-policy.js';
import type { QuoteSigner } from './ports/quote-signer.js';
import { assertKmsSigningChains } from './signing-policy.js';

export interface SigningSetup {
  feeWrapper: Hex;
  signer: QuoteSigner;
  ttlSeconds: number;
}

export interface SignerSetupDeps {
  /** Routers quotes may use; with a KMS signer every quoted chain must have an entry. */
  policy: RoutePolicy;
  /** Builds the KMS transport for a region (the AWS SDK client in production). */
  kmsTransport: (region: string) => KmsTransport;
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string | undefined;
}

/**
 * The KMS key must be pinned (full key ARN plus expected address) in production and whenever
 * the API would sign for any chain that is not a known testnet or local chain. Unknown chains
 * count as mainnets (fail closed).
 */
export function kmsPinRequired(config: Config, nodeEnv: string | undefined): boolean {
  if (nodeEnv?.trim().toLowerCase() === 'production') return true;
  return config.ZEROX_CHAIN_IDS.some((id) => !LOCAL_SIGNER_DEFAULT_CHAINS.includes(id));
}

/**
 * Chooses and checks the quote signer at startup. Config already refuses both signers at
 * once (ADR 0005).
 *
 * - `KMS_KEY_ID`: a KMS signer for `ZEROX_CHAIN_IDS`, which may include mainnets. The key is
 *   checked and its address derived before the server starts; any KMS error fails startup.
 *   Every quoted chain must have a trusted router policy. In production or with any mainnet,
 *   KMS_KEY_ID must be a full key ARN and the derived address must equal
 *   KMS_EXPECTED_SIGNER_ADDRESS (when set, it is checked in development too).
 * - `QUOTE_SIGNER_PRIVATE_KEY`: a local key, testnets and local chains only (ADR 0004).
 * - Neither: quotes are returned unsigned.
 *
 * Follow-up, not built (needs RPC access): compare `FeeWrapper.feeSigner()` on each signing
 * chain with `signer.address` here and refuse to start on a mismatch (ADR 0005).
 */
export async function setUpSigning(
  config: Config,
  deps: SignerSetupDeps,
): Promise<SigningSetup | undefined> {
  if (config.KMS_KEY_ID) {
    if (!config.FEE_WRAPPER_ADDRESS) {
      throw new Error('KMS_KEY_ID is set but FEE_WRAPPER_ADDRESS is not');
    }
    if (!config.AWS_REGION) throw new Error('AWS_REGION is required when KMS_KEY_ID is set');
    const nodeEnv = 'nodeEnv' in deps ? deps.nodeEnv : process.env.NODE_ENV;
    const expected = config.KMS_EXPECTED_SIGNER_ADDRESS;
    if (kmsPinRequired(config, nodeEnv)) {
      if (!expected) {
        throw new Error(
          'KMS_EXPECTED_SIGNER_ADDRESS is required in production and for mainnet chains: set it ' +
            "to the wrapper's feeSigner address (docs/runbooks/kms-setup.md)",
        );
      }
      if (!KMS_KEY_ARN.test(config.KMS_KEY_ID)) {
        throw new Error(
          'KMS_KEY_ID must be a full key ARN (arn:aws:kms:<region>:<account>:key/<uuid>), not an ' +
            'alias or key ID, in production and for mainnet chains',
        );
      }
    }
    let signer: KmsSigner;
    try {
      signer = await KmsSigner.create({
        keyId: config.KMS_KEY_ID,
        transport: deps.kmsTransport(config.AWS_REGION),
        chainIds: config.ZEROX_CHAIN_IDS,
        timeoutMs: config.KMS_SIGN_TIMEOUT_MS,
        maxInFlight: config.KMS_MAX_IN_FLIGHT,
        maxQueue: config.KMS_MAX_QUEUE,
      });
    } catch (err: unknown) {
      throw new Error(`KMS signer startup failed: ${errorMessage(err)}`, { cause: err });
    }
    if (expected && expected.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(
        `KMS key ${signer.keyArn} derives to ${signer.address}, but KMS_EXPECTED_SIGNER_ADDRESS ` +
          `is ${expected}. Refusing to start with an unexpected fee signer.`,
      );
    }
    assertKmsSigningChains(config.ZEROX_CHAIN_IDS, signer, deps.policy);
    return {
      feeWrapper: config.FEE_WRAPPER_ADDRESS as Hex,
      signer,
      ttlSeconds: config.QUOTE_TTL_SECONDS,
    };
  }

  if (config.QUOTE_SIGNER_PRIVATE_KEY && config.FEE_WRAPPER_ADDRESS) {
    // Refuses NODE_ENV=production and any mainnet chain ID; then every chain the API quotes
    // must be signable, or startup fails here rather than at the first quote.
    const signer = new LocalKeySigner(config.QUOTE_SIGNER_PRIVATE_KEY as Hex, {
      ...(config.LOCAL_SIGNER_CHAIN_IDS ? { allowedChainIds: config.LOCAL_SIGNER_CHAIN_IDS } : {}),
    });
    assertLocalSigningChains(config.ZEROX_CHAIN_IDS, signer);
    return {
      feeWrapper: config.FEE_WRAPPER_ADDRESS as Hex,
      signer,
      ttlSeconds: config.QUOTE_TTL_SECONDS,
    };
  }
  return undefined;
}

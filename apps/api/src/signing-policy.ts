import { NEVER_LOCAL_CHAINS } from './adapters/signers/local-key.js';
import type { RoutePolicy } from './domain/route-policy.js';
import type { QuoteSigner } from './ports/quote-signer.js';

/**
 * Whether a quote on `chainId` may be signed. All of these must hold (ADR 0005):
 *
 * 1. the signer itself agrees (`canSign`: a local key only for its testnet allowlist, a KMS
 *    key only for its configured chains);
 * 2. the chain has a trusted router policy, so every route on it went through `vetRoute`
 *    against a known router and Settler set (ADR 0004);
 * 3. a chain a local key may never sign for (every mainnet and live chain) is signable only
 *    by a KMS signer, whatever any signer's `canSign` claims.
 */
export function canSignChain(signer: QuoteSigner, policy: RoutePolicy, chainId: number): boolean {
  if (!signer.canSign(chainId)) return false;
  if ((policy.get(chainId)?.length ?? 0) === 0) return false;
  if (NEVER_LOCAL_CHAINS.has(chainId) && signer.kind !== 'kms') return false;
  return true;
}

/**
 * Startup check for a KMS signer: every chain the API quotes must be signable, which means
 * it must have a trusted router policy. Throws a message naming the offending chains.
 */
export function assertKmsSigningChains(
  signingChainIds: readonly number[],
  signer: QuoteSigner,
  policy: RoutePolicy,
): void {
  if (signer.kind !== 'kms') throw new Error('assertKmsSigningChains needs a KMS signer');
  const refused = signingChainIds.filter((id) => !canSignChain(signer, policy, id));
  if (refused.length > 0) {
    throw new Error(
      `KMS_KEY_ID is set but ZEROX_CHAIN_IDS includes chain(s) ${refused.join(', ')} without a ` +
        'trusted router policy (TRUSTED_ROUTERS). Quotes are only signed for chains whose ' +
        'routers and Settlers are listed in apps/api/src/trusted-routers.ts.',
    );
  }
}

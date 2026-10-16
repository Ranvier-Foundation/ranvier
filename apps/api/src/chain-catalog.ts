import {
  CHAINS,
  getChain,
  listTokens,
  searchTokenList,
  type ChainConfig,
  type CuratedToken,
} from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import { NEVER_LOCAL_CHAINS } from './adapters/signers/local-key.js';
import { LOCAL_SIGNER_DEFAULT_CHAINS } from './mainnet-rules.js';

/**
 * The chains and curated token lists the HTTP layer serves (ADR 0013, section 2): GET /v1/chains,
 * GET /v1/tokens, POST /v1/balances and the direct-wrap lookup read them from here instead of the
 * registry directly.
 *
 * Production serves `REGISTRY_CATALOG` only: `buildServer` takes no catalog at all. A wider
 * catalog exists only in the local test harness (`src/harness/`, excluded from the build), which
 * passes it to `buildServerWithCatalog`.
 *
 * What a catalog can NOT change, by construction: the fee schedule (`@ranvier/fees` reads the
 * registry's stablecoin and wrapped-native data itself), the price oracle and its trusted
 * decimals (`DefiLlamaPriceOracle` reads the registry), the trusted router policy and every
 * signing list (`NEVER_LOCAL_CHAINS`, `LOCAL_SIGNER_DEFAULT_CHAINS`, `canSignChain`). A direct
 * wrap still needs the fee schedule to call the pair a wrap, so a chain outside the registry
 * never gets one.
 */
export interface ChainCatalog {
  /** Every chain, in display order: the registry's `CHAINS` first. */
  readonly chains: readonly ChainConfig[];
  getChain(key: ChainKey): ChainConfig | undefined;
  /** The curated tokens of a chain in display order; empty for a chain with no list. */
  listTokens(key: ChainKey): readonly CuratedToken[];
}

/** The registry itself: `CHAINS`, `getChain`, `listTokens` from `@ranvier/chains`, unchanged. */
export const REGISTRY_CATALOG: ChainCatalog = Object.freeze({
  chains: CHAINS,
  getChain,
  listTokens,
});

/** `searchTokens` over a catalog's list (same rules and order as `@ranvier/chains`). */
export function searchCatalog(
  catalog: ChainCatalog,
  key: ChainKey,
  query: string,
  limit: number,
): CuratedToken[] {
  return searchTokenList(catalog.listTokens(key), query, limit);
}

/** The numeric chain ID of an EVM chain config, else undefined. */
export function evmChainIdOf(chain: Pick<ChainConfig, 'family' | 'key'>): number | undefined {
  if (chain.family !== 'evm') return undefined;
  const match = /^evm:([1-9]\d{0,9})$/.exec(chain.key);
  return match ? Number(match[1]) : undefined;
}

/** A catalog that does not extend the registry as allowed. Startup refuses it. */
export class ChainCatalogError extends Error {
  override readonly name = 'ChainCatalogError';
}

const sameTokens = (a: readonly CuratedToken[], b: readonly CuratedToken[]): boolean =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Throws `ChainCatalogError` unless `catalog` is the registry, unchanged, plus at most a few extra
 * chains that a local key may sign for and no live chain ever is:
 *
 * - `chains` starts with exactly the registry's `CHAINS` (the same objects, in order), and
 *   `getChain` / `listTokens` answer the registry's own values for every registry chain;
 * - every extra chain is EVM with a canonical key, in `LOCAL_SIGNER_DEFAULT_CHAINS` and not in
 *   `NEVER_LOCAL_CHAINS` (so never a mainnet or a registry chain), listed once, with no
 *   stablecoins (a catalog never selects a fee rate) and only its own tokens.
 */
export function assertCatalogExtendsRegistry(catalog: ChainCatalog): void {
  const refuse = (why: string): never => {
    throw new ChainCatalogError(`chain catalog refused: ${why}`);
  };
  CHAINS.forEach((chain, i) => {
    if (catalog.chains[i] !== chain) refuse(`registry chain ${chain.key} is not unchanged`);
    if (catalog.getChain(chain.key) !== chain) refuse(`getChain(${chain.key}) is not the registry`);
    if (!sameTokens(catalog.listTokens(chain.key), listTokens(chain.key))) {
      refuse(`the token list of ${chain.key} is not the registry's`);
    }
  });
  const seen = new Set<string>(CHAINS.map((c) => c.key));
  for (const extra of catalog.chains.slice(CHAINS.length)) {
    const id = evmChainIdOf(extra);
    if (id === undefined) refuse(`extra chain ${extra.key} is not a canonical EVM chain`);
    else if (!LOCAL_SIGNER_DEFAULT_CHAINS.includes(id) || NEVER_LOCAL_CHAINS.has(id)) {
      refuse(`extra chain ${extra.key} is not a local or test chain`);
    }
    if (seen.has(extra.key)) refuse(`chain ${extra.key} is listed twice`);
    seen.add(extra.key);
    if (catalog.getChain(extra.key) !== extra) refuse(`getChain(${extra.key}) disagrees`);
    if (Object.keys(extra.stablecoins).length > 0) {
      refuse(`extra chain ${extra.key} lists stablecoins`);
    }
    if (catalog.listTokens(extra.key).some((t) => t.chain !== extra.key)) {
      refuse(`extra chain ${extra.key} lists another chain's token`);
    }
  }
}

/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, section 2).
 * Lives in `src/harness/`: excluded from the build (`dist/`), never imported by production code.
 *
 * The harness chain catalog: the registry, unchanged, plus `LOCAL_DEV_CHAIN` (chain 31337 and its
 * mock tokens). Only the harness entry passes it to `buildServerWithCatalog`; production
 * `buildServer` refuses any catalog. It changes what /v1/chains, /v1/tokens and /v1/balances serve,
 * nothing else: the fee schedule and the real price oracle still read the registry only.
 */
import { displayOrder, type CuratedToken } from '@ranvier/chains';
import { LOCAL_DEV_CHAIN } from '@ranvier/chains/local-dev';
import type { ChainKey } from '@ranvier/types';
import {
  assertCatalogExtendsRegistry,
  REGISTRY_CATALOG,
  type ChainCatalog,
} from '../chain-catalog.js';
import { HARNESS_CHAIN_KEY } from './pinned.js';

/** Registry + `LOCAL_DEV_CHAIN`, frozen, and checked by the same rule `buildServer` applies. */
export function harnessCatalog(): ChainCatalog {
  // pinned.ts refuses to load unless local-dev names evm:31337, so this is the local chain.
  const key: ChainKey = HARNESS_CHAIN_KEY;
  const tokens: readonly CuratedToken[] = Object.freeze(displayOrder(LOCAL_DEV_CHAIN.tokens));
  const catalog: ChainCatalog = Object.freeze({
    chains: Object.freeze([...REGISTRY_CATALOG.chains, LOCAL_DEV_CHAIN]),
    getChain: (k: ChainKey) => (k === key ? LOCAL_DEV_CHAIN : REGISTRY_CATALOG.getChain(k)),
    listTokens: (k: ChainKey) => (k === key ? tokens : REGISTRY_CATALOG.listTokens(k)),
  });
  assertCatalogExtendsRegistry(catalog);
  return catalog;
}

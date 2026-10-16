import type { ChainFamily, ChainKey, TokenInfo, TokenTag } from '@ranvier/types';
import type { FastifyInstance } from 'fastify';
import {
  evmChainIdOf,
  REGISTRY_CATALOG,
  searchCatalog,
  type ChainCatalog,
} from '../chain-catalog.js';
import { invalidRequest, tokensQuerySchemaFor } from './schemas.js';

/**
 * Static data: the browser may keep list responses for five minutes. `private`, so no shared
 * cache stores them: a CDN put in front of the API must key on Origin (the responses carry
 * `Vary: Origin` and per-origin CORS headers) or bypass caching for /v1/* (ADR 0006).
 */
export const LIST_CACHE_CONTROL = 'private, max-age=300';

export interface ChainView {
  key: ChainKey;
  name: string;
  family: ChainFamily;
  nativeSymbol: string;
  nativeDecimals: number;
  explorer: string;
  /** True when this API can quote swaps on the chain right now. */
  quoting: boolean;
  /**
   * True when POST /v1/balances can read the chain right now: it has a curated token list and at
   * least one RPC endpoint that proved it serves this chain (ADR 0009).
   */
  balances: boolean;
}

export interface TokenView {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
  tags: TokenTag[];
}

export interface ListOptions {
  /** EVM chain IDs the API serves (ZEROX_CHAIN_IDS). Chains not in the registry are skipped. */
  servedChainIds: readonly number[];
  /** Whether quoting is enabled on a served chain. */
  quoting: (chainId: number) => boolean;
  /** Whether balances can be read on a served chain right now (default: never). */
  balances?: (chainId: number) => boolean;
  /** Chains and token lists (default: the registry; production never passes another). */
  catalog?: ChainCatalog;
}

/**
 * The served chains, in catalog (registry) order. Fields are copied one by one, so registry-only
 * values (oracle names, allowlists) never reach a client.
 */
export function servedChains(opts: ListOptions): ChainView[] {
  const served = new Set(opts.servedChainIds);
  return (opts.catalog ?? REGISTRY_CATALOG).chains.flatMap((c) => {
    const id = evmChainIdOf(c);
    if (id === undefined || !served.has(id)) return [];
    return [
      {
        key: c.key,
        name: c.name,
        family: c.family,
        nativeSymbol: c.nativeSymbol,
        nativeDecimals: c.nativeDecimals,
        explorer: c.explorer,
        quoting: opts.quoting(id),
        balances: opts.balances?.(id) ?? false,
      },
    ];
  });
}

function tokenView(t: TokenInfo): TokenView {
  return {
    chain: t.chain,
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    ...(t.logoUri !== undefined ? { logoUri: t.logoUri } : {}),
    tags: [...(t.tags ?? [])],
  };
}

/**
 * GET /v1/chains and GET /v1/tokens (ADR 0006). Both answer from checked-in data only: no
 * provider, oracle or signer is called, and no request value is echoed back.
 */
export function registerListRoutes(app: FastifyInstance, opts: ListOptions): void {
  const catalog = opts.catalog ?? REGISTRY_CATALOG;
  const tokensQuerySchema = tokensQuerySchemaFor(catalog);
  // Computed per request: `balances` follows RPC endpoint health.
  app.get('/v1/chains', async (_req, reply) => {
    return reply.header('cache-control', LIST_CACHE_CONTROL).send(servedChains(opts));
  });

  app.get('/v1/tokens', async (req, reply) => {
    const parsed = tokensQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(invalidRequest(parsed.error));
    const { chain, q, limit } = parsed.data;
    const tokens = searchCatalog(catalog, chain, q ?? '', limit).map(tokenView);
    return reply.header('cache-control', LIST_CACHE_CONTROL).send(tokens);
  });
}

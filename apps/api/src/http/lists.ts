import { CHAINS, searchTokens } from '@ranvier/chains';
import type { ChainFamily, ChainKey, TokenInfo, TokenTag } from '@ranvier/types';
import type { FastifyInstance } from 'fastify';
import { invalidRequest, tokensQuerySchema } from './schemas.js';

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
}

/**
 * The served chains, in registry order. Fields are copied one by one, so registry-only values
 * (oracle names, allowlists) never reach a client.
 */
export function servedChains(opts: ListOptions): ChainView[] {
  const served = new Set(opts.servedChainIds);
  return CHAINS.flatMap((c) => {
    const id = c.family === 'evm' ? Number(c.key.slice('evm:'.length)) : undefined;
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
  // Computed once: the served set and quoting flags are fixed at startup.
  const chains = servedChains(opts);

  app.get('/v1/chains', async (_req, reply) => {
    return reply.header('cache-control', LIST_CACHE_CONTROL).send(chains);
  });

  app.get('/v1/tokens', async (req, reply) => {
    const parsed = tokensQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(invalidRequest(parsed.error));
    const { chain, q, limit } = parsed.data;
    const tokens = searchTokens(chain, q ?? '', limit).map(tokenView);
    return reply.header('cache-control', LIST_CACHE_CONTROL).send(tokens);
  });
}

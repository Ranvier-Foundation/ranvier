import type { FastifyInstance } from 'fastify';
import type { BalanceService } from '../domain/balances.js';
import { ChainReadError } from '../ports/chain-reader.js';
import { balancesQuerySchema, invalidRequest } from './schemas.js';

/**
 * Balances are per wallet: no cache, shared or private, may store them. Set on every response
 * of the route, errors included.
 */
export const BALANCES_CACHE_CONTROL = 'private, no-store';

export interface BalanceRouteOptions {
  /** Unset: the route validates requests and answers 503 `rpc_unavailable`. */
  service?: BalanceService | undefined;
  /** Per-request deadline (default 3000 ms); past it the answer is 504 `timeout`. */
  deadlineMs?: number | undefined;
}

export interface BalancesView {
  chain: string;
  address: string;
  blockNumber: string;
  balances: { address: string; balance: string | null }[];
}

/**
 * GET /v1/balances?chain=<ChainKey>&address=<0x...> (ADR 0009). Answers with stable codes only:
 * `invalid_request` (400), `rpc_unavailable` (503) and `timeout` (504). Never a URL, provider
 * text or the raw query. The address is never logged (see `requestLogSerializer`).
 */
export function registerBalanceRoutes(app: FastifyInstance, opts: BalanceRouteOptions): void {
  const service = opts.service;
  const deadlineMs = opts.deadlineMs ?? 3_000;
  const schema = balancesQuerySchema((chain) => service?.serves(chain) ?? false);

  app.get('/v1/balances', async (req, reply) => {
    reply.header('cache-control', BALANCES_CACHE_CONTROL);
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(invalidRequest(parsed.error));
    const { chain, address } = parsed.data;
    const chainId = Number(chain.slice('evm:'.length));
    if (!service?.available(chainId)) {
      return reply.code(503).send({ error: 'rpc_unavailable' });
    }
    try {
      const result = await service.balances(chain, address, AbortSignal.timeout(deadlineMs));
      const view: BalancesView = {
        chain: result.chain,
        address: result.address,
        blockNumber: result.blockNumber.toString(),
        balances: result.balances.map((b) => ({
          address: b.address,
          balance: b.balance === null ? null : b.balance.toString(),
        })),
      };
      return view;
    } catch (err: unknown) {
      if (!(err instanceof ChainReadError)) throw err;
      // The reason is fixed text (no URL, no address); the code is all the client gets.
      req.log.warn({ chainId, reason: err.reason }, 'balances unavailable');
      return err.code === 'timeout'
        ? reply.code(504).send({ error: 'timeout' })
        : reply.code(503).send({ error: 'rpc_unavailable' });
    }
  });
}

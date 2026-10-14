import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BalanceService } from '../domain/balances.js';
import { ChainReadError } from '../ports/chain-reader.js';
import { balancesRequestSchema, invalidRequest } from './schemas.js';

/**
 * Balances are per wallet: no cache, shared or private, may store them. Set on every response
 * of the route, errors included (by a route `onSend` hook, so framework errors such as a 413 or a
 * malformed JSON body carry it too).
 */
export const BALANCES_CACHE_CONTROL = 'private, no-store';
/** Largest accepted request body: `{"chain":"evm:4294967295","address":"0x…"}` is ~80 bytes. */
export const BALANCES_BODY_LIMIT = 1024;

export interface BalanceRouteOptions {
  /** Unset: no chain is served, every request is `400 invalid_request`. */
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

const noStore = async (_req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
  reply.header('cache-control', BALANCES_CACHE_CONTROL);
  return payload;
};

/** `application/json`, with or without parameters (`; charset=utf-8`). */
function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * POST /v1/balances with a JSON body `{ "chain": "evm:1", "address": "0x…" }` (ADR 0009).
 *
 * POST, not GET: URLs are logged by every layer (proxies, CDNs, WAFs, browser history), request
 * bodies are not by default, and the wallet address is personal data.
 *
 * Answers with stable codes only: `invalid_request` (400; 415 for a body that is not JSON),
 * `payload_too_large` (413), `method_not_allowed` (405 for GET and HEAD, which never read),
 * `rpc_unavailable` (503) and `timeout` (504). Never a URL, provider text or the raw input.
 */
export function registerBalanceRoutes(app: FastifyInstance, opts: BalanceRouteOptions): void {
  const service = opts.service;
  const deadlineMs = opts.deadlineMs ?? 3_000;
  const schema = balancesRequestSchema((chain) => service?.serves(chain) ?? false);

  // GET (and the HEAD Fastify derives from it) only says which method to use: no read.
  app.get('/v1/balances', { onSend: noStore }, async (_req, reply) =>
    reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed' }),
  );

  app.post(
    '/v1/balances',
    { bodyLimit: BALANCES_BODY_LIMIT, onSend: noStore },
    async (req, reply) => {
      if (!isJson(req.headers['content-type'])) {
        return reply.code(415).send({ error: 'invalid_request' });
      }
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(invalidRequest(parsed.error));
      const { chain, address } = parsed.data;
      const chainId = Number(chain.slice('evm:'.length));
      if (!service?.available(chainId)) {
        return reply.code(503).send({ error: 'rpc_unavailable' });
      }
      // A client that hangs up abandons the read (and frees its share of the limiter).
      const disconnected = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) disconnected.abort();
      };
      reply.raw.on('close', onClose);
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(deadlineMs), disconnected.signal]);
        const result = await service.balances(chain, address, signal);
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
        req.log.warn(
          { chainId, reason: err.reason, disconnected: disconnected.signal.aborted },
          'balances unavailable',
        );
        return err.code === 'timeout'
          ? reply.code(504).send({ error: 'timeout' })
          : reply.code(503).send({ error: 'rpc_unavailable' });
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );
}

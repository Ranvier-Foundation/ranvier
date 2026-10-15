import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { quoteFee } from '@ranvier/fees';
import type { Hex } from 'viem';
import { randomBytes } from 'node:crypto';
import type { BalanceService } from '../domain/balances.js';
import { compareProviderQuotes } from '../domain/orchestrator.js';
import type { RoutePolicy } from '../domain/route-policy.js';
import { vetRoute } from '../domain/route-safety.js';
import {
  directAnswerEcho,
  signedAnswerEcho,
  signedDeadline,
  type QuoteTiming,
} from '../domain/quote-answer.js';
import { buildSignedSwap, sameChainEvmContext } from '../domain/swap-quote.js';
import { usdCents } from '../domain/usd.js';
import { buildDirectWrap } from '../domain/wrap.js';
import type { PriceOracle, SwapHistory, TokenPrice } from '../ports/price-oracle.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import { SigningUnavailableError, type QuoteSigner } from '../ports/quote-signer.js';
import { canSignChain } from '../signing-policy.js';
import { registerBalanceRoutes } from './balances.js';
import { registerCors } from './cors.js';
import { registerListRoutes } from './lists.js';
import { feePreviewSchema, invalidRequest, quoteRequestSchema } from './schemas.js';

export interface ServerDeps {
  providers: readonly QuoteProvider[];
  prices?: PriceOracle;
  history?: SwapHistory;
  /** Routers and Settler targets quotes may use; anything else is refused (ADR 0004). */
  routePolicy?: RoutePolicy;
  providerTimeoutMs?: number;
  /** Largest accepted `slippageBps` (default 1000). */
  maxSlippageBps?: number;
  /** Largest output shortfall against the oracle, in bps (default 500). */
  maxOracleDeviationBps?: number;
  /** `true` logs JSON to stdout; tests pass a stream to inspect the lines. */
  logger?: boolean | { stream: { write(line: string): void }; level?: string };
  /** Exact browser origins allowed to call the API (WEB_ORIGINS). Default: none. */
  webOrigins?: readonly string[];
  /** EVM chain IDs listed by GET /v1/chains (ZEROX_CHAIN_IDS). Default: none. */
  servedChainIds?: readonly number[];
  /** POST /v1/balances (ADR 0009). Unset: no chain is served (`400 invalid_request`). */
  balances?: { service: BalanceService; deadlineMs?: number };
  /** When set, quotes include a signed fee-wrapper transaction. */
  signing?: {
    feeWrapper: Hex;
    signer: QuoteSigner;
    ttlSeconds: number;
    now?: () => number;
    nonce?: () => bigint;
  };
}

function randomNonce(): bigint {
  return BigInt(`0x${randomBytes(32).toString('hex')}`);
}

/** JSON cannot carry bigint; send base-unit amounts as decimal strings. */
function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

/** Error name and a bounded message for logs: enough to debug, never a calldata dump. */
function errSummary(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message.slice(0, 200) };
  return { name: typeof err, message: String(err).slice(0, 200) };
}

/**
 * The request as logged by Fastify ("incoming request"). Its default serializer logs `req.url`
 * with the query string, which may hold a wallet address: personal data that must never reach
 * the logs (ADR 0009). Only the path is logged, for every route.
 */
export function requestLogSerializer(req: FastifyRequest): Record<string, unknown> {
  const q = req.url.indexOf('?');
  return {
    method: req.method,
    url: q === -1 ? req.url : req.url.slice(0, q),
    hostname: req.hostname,
    remoteAddress: req.ip,
  };
}

function loggerOptions(logger: ServerDeps['logger']) {
  if (!logger) return false;
  return {
    ...(typeof logger === 'object' ? logger : {}),
    serializers: { req: requestLogSerializer },
  };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(deps.logger),
    bodyLimit: 16 * 1024,
    // Fastify's own answer to a malformed URL (e.g. `/v1/x%zz`) echoes the URL and skips the
    // error handler and hooks: replace it with the stable code, uncacheable.
    frameworkErrors: (err, req, reply) => {
      req.log.info({ err: { name: err.name, code: err.code } }, 'rejected request');
      return (
        (reply as FastifyReply)
          .code(400)
          .header('cache-control', 'no-store')
          // Hooks (CORS among them) do not run for framework errors; Vary is harmless without CORS.
          .header('vary', 'Origin')
          .send({ error: 'invalid_request' })
      );
    },
  });
  const quoteSchema = quoteRequestSchema({ maxSlippageBps: deps.maxSlippageBps ?? 1_000 });
  const maxOracleDeviationBps = deps.maxOracleDeviationBps ?? 500;
  // Before any route, so every response (errors and 404s included) carries the CORS decision.
  registerCors(app, deps.webOrigins ?? []);

  // Clients get stable codes only; details stay in the server log.
  app.setErrorHandler((err, req, reply) => {
    const status =
      typeof err === 'object' && err !== null && 'statusCode' in err ? err.statusCode : 500;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Name and code only: a client error's message can quote the request (a JSON parse error
      // quotes the body, which may hold a wallet address).
      const code = (err as { code?: unknown }).code;
      req.log.info({ err: { name: errSummary(err).name, code } }, 'rejected request');
      return reply
        .code(status)
        .send({ error: status === 413 ? 'payload_too_large' : 'invalid_request' });
    }
    req.log.error({ err: errSummary(err) }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.get('/health', async () => ({ status: 'ok' }));

  // Quoting needs the same dependencies /v1/quotes checks, and a trusted router on the chain.
  const routingConfigured =
    deps.providers.length > 0 && !!deps.prices && !!deps.history && !!deps.routePolicy;
  registerListRoutes(app, {
    servedChainIds: deps.servedChainIds ?? [],
    quoting: (chainId) => routingConfigured && (deps.routePolicy?.has(chainId) ?? false),
    balances: (chainId) => deps.balances?.service.available(chainId) ?? false,
  });
  const balanceService = deps.balances?.service;
  if (balanceService) app.addHook('onClose', async () => balanceService.close());
  registerBalanceRoutes(app, {
    service: deps.balances?.service,
    deadlineMs: deps.balances?.deadlineMs,
  });

  app.post('/v1/fees/preview', async (req, reply) => {
    const parsed = feePreviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(invalidRequest(parsed.error));
    const { usdValueCents, ...rest } = parsed.data;
    return toJson(quoteFee({ ...rest, usdValue: usdValueCents }));
  });

  app.post('/v1/quotes', async (req, reply) => {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(invalidRequest(parsed.error));
    const request = parsed.data;

    // Native wrap/unwrap is free by the fee schedule and 1:1 on the wrapped native contract,
    // so it bypasses providers, the price oracle, the fee wrapper and signing (ADR 0003).
    const wrap = buildDirectWrap(request);
    if (wrap) {
      // USD value and first-swap status cannot change a 0 bps fee, so neither is fetched.
      const fee = quoteFee({ ...request, usdValue: 0n, isFirstSwap: false });
      if (fee.reason !== 'wrap-unwrap' || fee.amount !== 0n) {
        req.log.error({ fee }, 'wrap detected but fee schedule did not return a free wrap');
        return reply.code(500).send({ error: 'internal_error' });
      }
      // The chain the transaction is for, from the validated request (ADR 0012).
      return toJson({ fee, direct: wrap, ...directAnswerEcho(request) });
    }

    if (deps.providers.length === 0 || !deps.prices || !deps.history || !deps.routePolicy) {
      return reply
        .code(503)
        .send({ error: 'routing_unavailable', message: 'No routing providers are configured' });
    }
    const routePolicy = deps.routePolicy;

    // Trusted decimals and prices for both sides, before any paid provider call. Without them
    // the fee tier cannot be set and no route can be bounded, so no quote is offered.
    const timeoutMs = deps.providerTimeoutMs ?? 2500;
    let sellPrice: TokenPrice;
    let buyPrice: TokenPrice;
    let hasSwapped: boolean;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      [sellPrice, buyPrice, hasSwapped] = await Promise.all([
        deps.prices.price(request.sellToken, signal),
        deps.prices.price(request.buyToken, signal),
        deps.history.hasCompletedSwap(request.taker),
      ]);
    } catch (err: unknown) {
      req.log.warn({ err: errSummary(err) }, 'fee inputs unavailable');
      return reply.code(503).send({ error: 'price_unavailable' });
    }
    const usdValue = usdCents(sellPrice, request.sellAmount);
    const fee = quoteFee({ ...request, usdValue, isFirstSwap: !hasSwapped });
    const netSell = { ...request, sellAmount: request.sellAmount - fee.amount };

    const comparison = await compareProviderQuotes(deps.providers, netSell, {
      timeoutMs,
      vet: (quote) =>
        vetRoute(
          { request: netSell, sellPrice, buyPrice, policy: routePolicy, maxOracleDeviationBps },
          quote,
        ),
      onFailure: (failure, err) =>
        req.log.warn({ ...failure, err: errSummary(err) }, 'provider quote failed'),
    });
    if (!comparison.best) {
      return reply.code(502).send({ error: 'no_route', failures: comparison.failures });
    }
    const signing = deps.signing;
    const chain = sameChainEvmContext(request);
    if (!signing || !chain) return toJson({ fee, ...comparison });
    const { chainId } = chain;
    // The signer must accept the chain, the chain must have a trusted router policy, and a
    // mainnet needs a KMS signer (ADR 0005).
    if (!canSignChain(signing.signer, routePolicy, chainId)) {
      req.log.error({ chainId }, 'signer refuses a chain providers quoted');
      return reply.code(503).send({ error: 'signing_unavailable' });
    }

    // One clock reading: the signed deadline is computed from it and it is echoed as serverTime.
    const timing: QuoteTiming = {
      serverTime: Math.floor((signing.now ?? Date.now)() / 1000),
      ttlSeconds: signing.ttlSeconds,
    };
    let swap;
    try {
      swap = await buildSignedSwap({
        request,
        fee,
        route: comparison.best,
        feeWrapper: signing.feeWrapper,
        signer: signing.signer,
        deadline: signedDeadline(timing),
        nonce: (signing.nonce ?? randomNonce)(),
      });
    } catch (err: unknown) {
      // Busy, timed out, upstream (KMS) failure or a signature that failed self-verification.
      // Clients get the stable code only; the reason goes to the log.
      if (!(err instanceof SigningUnavailableError)) throw err;
      const level = err.reason === 'integrity' ? 'error' : 'warn';
      req.log[level]({ chainId, reason: err.reason, err: errSummary(err) }, 'signing failed');
      return reply.code(503).send({ error: 'signing_unavailable' });
    }
    // The chain and timing echo is checked against the signed quote (ADR 0012); `swap` is
    // listed field by field so the signing context is not serialised twice.
    const echo = signedAnswerEcho(request, swap, timing);
    const { quote, signature, transaction } = swap;
    return toJson({ fee, ...comparison, swap: { quote, signature, transaction }, ...echo });
  });

  return app;
}

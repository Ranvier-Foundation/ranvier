import Fastify, { type FastifyInstance } from 'fastify';
import { quoteFee } from '@ranvier/fees';
import type { Hex } from 'viem';
import { randomBytes } from 'node:crypto';
import { compareProviderQuotes } from '../domain/orchestrator.js';
import type { RoutePolicy } from '../domain/route-policy.js';
import { vetRoute } from '../domain/route-safety.js';
import { buildSignedSwap, evmChainId } from '../domain/swap-quote.js';
import { usdCents } from '../domain/usd.js';
import { buildDirectWrap } from '../domain/wrap.js';
import type { PriceOracle, SwapHistory, TokenPrice } from '../ports/price-oracle.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import type { QuoteSigner } from '../ports/quote-signer.js';
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
  logger?: boolean;
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

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024 });
  const quoteSchema = quoteRequestSchema({ maxSlippageBps: deps.maxSlippageBps ?? 1_000 });
  const maxOracleDeviationBps = deps.maxOracleDeviationBps ?? 500;

  // Clients get stable codes only; details stay in the server log.
  app.setErrorHandler((err, req, reply) => {
    const status =
      typeof err === 'object' && err !== null && 'statusCode' in err ? err.statusCode : 500;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      req.log.info({ err: errSummary(err) }, 'rejected request');
      return reply
        .code(status)
        .send({ error: status === 413 ? 'payload_too_large' : 'invalid_request' });
    }
    req.log.error({ err: errSummary(err) }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  app.get('/health', async () => ({ status: 'ok' }));

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
      return toJson({ fee, direct: wrap });
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
    const chainId = evmChainId(request.sellToken);
    const canSign =
      signing && chainId !== undefined && request.buyToken.chain === request.sellToken.chain;
    if (!canSign) return toJson({ fee, ...comparison });
    if (!signing.signer.canSign(chainId)) {
      req.log.error({ chainId }, 'signer refuses a chain providers quoted');
      return reply.code(503).send({ error: 'signing_unavailable' });
    }

    const nowSeconds = Math.floor((signing.now ?? Date.now)() / 1000);
    const swap = await buildSignedSwap({
      request,
      fee,
      route: comparison.best,
      feeWrapper: signing.feeWrapper,
      signer: signing.signer,
      deadline: BigInt(nowSeconds + signing.ttlSeconds),
      nonce: (signing.nonce ?? randomNonce)(),
    });
    return toJson({ fee, ...comparison, swap });
  });

  return app;
}

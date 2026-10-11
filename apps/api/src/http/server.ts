import Fastify, { type FastifyInstance } from 'fastify';
import { quoteFee } from '@ranvier/fees';
import { compareProviderQuotes } from '../domain/orchestrator.js';
import type { PriceOracle, SwapHistory } from '../ports/price-oracle.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import { feePreviewSchema, quoteRequestSchema } from './schemas.js';

export interface ServerDeps {
  providers: readonly QuoteProvider[];
  prices?: PriceOracle;
  history?: SwapHistory;
  providerTimeoutMs?: number;
  logger?: boolean;
}

/** JSON cannot carry bigint; send base-unit amounts as decimal strings. */
function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024 });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/v1/fees/preview', async (req, reply) => {
    const parsed = feePreviewSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    const { usdValueCents, ...rest } = parsed.data;
    return toJson(quoteFee({ ...rest, usdValue: usdValueCents }));
  });

  app.post('/v1/quotes', async (req, reply) => {
    const parsed = quoteRequestSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    if (deps.providers.length === 0 || !deps.prices || !deps.history) {
      return reply
        .code(503)
        .send({ error: 'routing_unavailable', message: 'No routing providers are configured' });
    }

    const request = parsed.data;
    const timeoutMs = deps.providerTimeoutMs ?? 700;
    let usdValue: bigint;
    let hasSwapped: boolean;
    try {
      [usdValue, hasSwapped] = await Promise.all([
        deps.prices.usdValue(request.sellToken, request.sellAmount, AbortSignal.timeout(timeoutMs)),
        deps.history.hasCompletedSwap(request.taker),
      ]);
    } catch (err: unknown) {
      req.log.warn({ err }, 'fee inputs unavailable');
      // Without a trusted USD value the fee tier cannot be set, so no quote is offered.
      return reply.code(503).send({ error: 'price_unavailable' });
    }
    const fee = quoteFee({ ...request, usdValue, isFirstSwap: !hasSwapped });
    const netSell = { ...request, sellAmount: request.sellAmount - fee.amount };

    const comparison = await compareProviderQuotes(deps.providers, netSell, { timeoutMs });
    if (!comparison.best) {
      return reply.code(502).send({ error: 'no_route', failures: comparison.failures });
    }
    return toJson({ fee, ...comparison });
  });

  return app;
}

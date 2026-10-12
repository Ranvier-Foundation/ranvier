import Fastify, { type FastifyInstance } from 'fastify';
import { quoteFee } from '@ranvier/fees';
import { compareProviderQuotes } from '../domain/orchestrator.js';
import { buildSignedSwap, evmChainId } from '../domain/swap-quote.js';
import type { PriceOracle, SwapHistory } from '../ports/price-oracle.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import type { QuoteSigner } from '../ports/quote-signer.js';
import type { Hex } from 'viem';
import { randomBytes } from 'node:crypto';
import { feePreviewSchema, quoteRequestSchema } from './schemas.js';

export interface ServerDeps {
  providers: readonly QuoteProvider[];
  prices?: PriceOracle;
  history?: SwapHistory;
  providerTimeoutMs?: number;
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
    const timeoutMs = deps.providerTimeoutMs ?? 2500;
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
    const signing = deps.signing;
    const canSign =
      signing &&
      evmChainId(request.sellToken) !== undefined &&
      request.buyToken.chain === request.sellToken.chain;
    if (!canSign) return toJson({ fee, ...comparison });

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

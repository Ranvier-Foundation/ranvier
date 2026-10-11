import { describe, expect, it } from 'vitest';
import type { ProviderQuote } from '@ranvier/types';
import { buildServer, type ServerDeps } from './server.js';

const ETH = { chain: 'evm:1', address: 'native', symbol: 'ETH', decimals: 18 };
const USDC = {
  chain: 'evm:1',
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  symbol: 'USDC',
  decimals: 6,
};
const quoteBody = {
  sellToken: ETH,
  buyToken: USDC,
  sellAmount: '1000000000000000000',
  taker: '0xabc',
  slippageBps: 50,
};

const deps = (overrides: Partial<ServerDeps> = {}): ServerDeps => ({
  providers: [
    {
      name: 'fake',
      supports: () => true,
      quote: async (req): Promise<ProviderQuote> => ({
        provider: 'fake',
        buyAmount: req.sellAmount / 10n ** 9n,
        minBuyAmount: 1n,
        buyAmountUsd: 2_000_00n,
        gasCostUsd: 50n,
        route: [],
        tx: { to: '0x1', data: '0x', value: req.sellAmount },
      }),
    },
  ],
  prices: { usdValue: async () => 2_000_00n },
  history: { hasCompletedSwap: async () => true },
  ...overrides,
});

describe('http', () => {
  it('reports health', async () => {
    const res = await buildServer(deps()).inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('previews fees with bigint amounts as strings', async () => {
    const res = await buildServer(deps()).inject({
      method: 'POST',
      url: '/v1/fees/preview',
      payload: { sellToken: ETH, buyToken: USDC, sellAmount: '1000000', usdValueCents: '500000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      bps: 20,
      reason: 'tier-under-10k',
      amount: '2000',
      waivedUsd: '0',
    });
  });

  it('rejects invalid input', async () => {
    const app = buildServer(deps());
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/fees/preview',
      payload: { sellAmount: '-1' },
    });
    expect(bad.statusCode).toBe(400);
    const zero = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: { ...quoteBody, sellAmount: '0' },
    });
    expect(zero.statusCode).toBe(400);
  });

  it('returns 503 when routing is not configured', async () => {
    const res = await buildServer({ providers: [] }).inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteBody,
    });
    expect(res.statusCode).toBe(503);
  });

  it('takes the fee before quoting and returns the best route', async () => {
    const res = await buildServer(deps()).inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fee).toEqual({
      bps: 20,
      reason: 'tier-under-10k',
      amount: '2000000000000000',
      waivedUsd: '0',
    });
    expect(body.best.tx.value).toBe('998000000000000000');
  });

  it('applies the first-swap promo for new wallets', async () => {
    const res = await buildServer(
      deps({
        prices: { usdValue: async () => 500_00n },
        history: { hasCompletedSwap: async () => false },
      }),
    ).inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody });
    expect(res.json().fee.reason).toBe('first-swap-promo');
  });

  it('charges a first swap only on the part above $1,000', async () => {
    const res = await buildServer(
      deps({
        prices: { usdValue: async () => 1_500_00n },
        history: { hasCompletedSwap: async () => false },
      }),
    ).inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody });
    // 1 ETH worth $1,500: 0.2% on the $500 above the waiver = 1/3 ETH * 0.002, rounded down.
    expect(res.json().fee).toEqual({
      bps: 20,
      reason: 'first-swap-promo',
      amount: '666666666666666',
      waivedUsd: '100000',
    });
  });

  it('returns 503 when the fee price is unavailable', async () => {
    const res = await buildServer(
      deps({ prices: { usdValue: async () => Promise.reject(new Error('oracle down')) } }),
    ).inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'price_unavailable' });
  });

  it('returns 502 when no provider can route', async () => {
    const res = await buildServer(
      deps({
        providers: [
          {
            name: 'down',
            supports: () => true,
            quote: async () => Promise.reject(new Error('down')),
          },
        ],
      }),
    ).inject({ method: 'POST', url: '/v1/quotes', payload: quoteBody });
    expect(res.statusCode).toBe(502);
    expect(res.json().failures[0].provider).toBe('down');
  });
});

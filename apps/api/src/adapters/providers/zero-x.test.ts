import { describe, expect, it } from 'vitest';
import type { QuoteRequest, TokenRef } from '@ranvier/types';
import type { PriceOracle } from '../../ports/price-oracle.js';
import { ProviderError } from '../../ports/provider-error.js';
import fixture from './fixtures/zero-x-quote.json' with { type: 'json' };
import { ZeroXProvider, ZEROX_ALLOWANCE_HOLDER } from './zero-x.js';

const WRAPPER = '0x00000000000000000000000000000000000fee01';
const USER = '0x00000000000000000000000000000000000000aa';
const WETH: TokenRef = { chain: 'evm:1', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' };
const DAI: TokenRef = { chain: 'evm:1', address: '0x6b175474e89094c44da98b954eedeac495271d0f' };
const ETH: TokenRef = { chain: 'evm:1', address: 'native' };

const req: QuoteRequest = {
  sellToken: WETH,
  buyToken: DAI,
  sellAmount: 100n * 10n ** 18n,
  taker: USER,
  slippageBps: 50,
};

/** $1 per whole 18-decimal token, so USD cents = amount / 10^16. */
const prices: PriceOracle = { price: async () => ({ decimals: 18, usdE18: 10n ** 18n }) };

function setup(body: unknown = fixture, status = 200) {
  const calls: { url: URL; headers: Headers }[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const provider = new ZeroXProvider({
    apiKey: 'test-key',
    feeWrapper: WRAPPER,
    chainIds: [1, 8453],
    prices,
    fetch: fetchStub,
  });
  return { provider, calls };
}

describe('ZeroXProvider.supports', () => {
  const { provider } = setup();
  it('supports same-chain swaps on configured EVM chains only', () => {
    expect(provider.supports(req)).toBe(true);
    expect(
      provider.supports({
        ...req,
        sellToken: { ...WETH, chain: 'evm:10' },
        buyToken: { ...DAI, chain: 'evm:10' },
      }),
    ).toBe(false);
    expect(provider.supports({ ...req, buyToken: { ...DAI, chain: 'evm:8453' } })).toBe(false);
    expect(provider.supports({ ...req, sellToken: { ...WETH, chain: 'solana:mainnet' } })).toBe(
      false,
    );
  });
});

describe('ZeroXProvider.quote', () => {
  it('quotes for the fee wrapper as taker and pays the user', async () => {
    const { provider, calls } = setup();
    await provider.quote(req, AbortSignal.timeout(1000));
    const { url, headers } = calls[0]!;
    expect(url.pathname).toBe('/swap/allowance-holder/quote');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      chainId: '1',
      sellToken: WETH.address,
      buyToken: DAI.address,
      sellAmount: '100000000000000000000',
      taker: WRAPPER,
      recipient: USER,
      txOrigin: USER,
      slippageBps: '50',
    });
    expect(headers.get('0x-api-key')).toBe('test-key');
    expect(headers.get('0x-version')).toBe('v2');
  });

  it('maps the 0x response', async () => {
    const { provider } = setup();
    // Fixture: a real USDC -> WETH quote on Base recorded from the live API on 2026-10-12.
    expect(await provider.quote(req, AbortSignal.timeout(1000))).toEqual({
      provider: '0x',
      buyAmount: 391197872355229192n,
      minBuyAmount: 389241882993453046n,
      // The test oracle prices every token at $1 with 18 decimals: cents = amount * 100 / 10^18.
      buyAmountUsd: (391197872355229192n * 100n) / 10n ** 18n,
      gasCostUsd: (3122680126329n * 100n) / 10n ** 18n,
      route: [
        {
          protocol: 'Metric_V2',
          from: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          to: '0x4200000000000000000000000000000000000006',
          proportionBps: 10000,
        },
      ],
      tx: { to: ZEROX_ALLOWANCE_HOLDER, data: fixture.transaction.data, value: 0n },
    });
  });

  it('starts pricing before the 0x quote returns', async () => {
    const events: string[] = [];
    const slowPrices: PriceOracle = {
      price: async (token) => {
        events.push(`price:${token.address}`);
        return { decimals: 18, usdE18: 0n };
      },
    };
    const fetchStub = (async () => {
      events.push('fetch');
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as typeof fetch;
    const provider = new ZeroXProvider({
      apiKey: 'k',
      feeWrapper: WRAPPER,
      chainIds: [1],
      prices: slowPrices,
      fetch: fetchStub,
    });
    await provider.quote(req, AbortSignal.timeout(1000));
    // Both lookups are issued before the request, never with client-supplied decimals.
    expect(events).toEqual([`price:${DAI.address}`, 'price:native', 'fetch']);
  });

  it('reports a pricing failure without an unhandled rejection', async () => {
    const failing: PriceOracle = { price: async () => Promise.reject(new Error('oracle down')) };
    const provider = new ZeroXProvider({
      apiKey: 'k',
      feeWrapper: WRAPPER,
      chainIds: [1],
      prices: failing,
      fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch,
    });
    await expect(provider.quote(req, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  it('uses the 0x sentinel for the native token', async () => {
    const { provider, calls } = setup();
    await provider.quote({ ...req, sellToken: ETH }, AbortSignal.timeout(1000));
    expect(calls[0]!.url.searchParams.get('sellToken')).toBe(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    );
  });

  it('treats a missing network fee as zero gas cost', async () => {
    const { provider } = setup({ ...fixture, totalNetworkFee: null });
    expect((await provider.quote(req, AbortSignal.timeout(1000))).gasCostUsd).toBe(0n);
  });

  it('reports no liquidity', async () => {
    const { provider } = setup({ liquidityAvailable: false, zid: '0x1' });
    await expect(provider.quote(req, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'no_liquidity',
    });
  });

  it('refuses routes that target an unexpected contract', async () => {
    const { provider } = setup({
      ...fixture,
      transaction: { ...fixture.transaction, to: '0x000000000000000000000000000000000000dead' },
    });
    await expect(provider.quote(req, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('rejects HTTP errors and malformed responses with stable codes', async () => {
    const http = setup({}, 500).provider.quote(req, AbortSignal.timeout(1000));
    await expect(http).rejects.toBeInstanceOf(ProviderError);
    await expect(http).rejects.toMatchObject({ code: 'upstream_error' });
    await expect(
      setup({ ...fixture, buyAmount: '-1' }).provider.quote(req, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('treats a non-JSON body as an invalid response', async () => {
    const provider = new ZeroXProvider({
      apiKey: 'k',
      feeWrapper: WRAPPER,
      chainIds: [1],
      prices,
      fetch: (async () => new Response('<html>', { status: 200 })) as typeof fetch,
    });
    await expect(provider.quote(req, AbortSignal.timeout(1000))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

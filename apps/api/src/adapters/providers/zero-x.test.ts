import { describe, expect, it } from 'vitest';
import type { QuoteRequest, Token } from '@ranvier/types';
import type { PriceOracle } from '../../ports/price-oracle.js';
import fixture from './fixtures/zero-x-quote.json' with { type: 'json' };
import {
  NoLiquidityError,
  UnexpectedRouterError,
  ZeroXProvider,
  ZEROX_ALLOWANCE_HOLDER,
} from './zero-x.js';

const WRAPPER = '0x00000000000000000000000000000000000fee01';
const USER = '0x00000000000000000000000000000000000000aa';
const WETH: Token = {
  chain: 'evm:1',
  address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  symbol: 'WETH',
  decimals: 18,
};
const DAI: Token = {
  chain: 'evm:1',
  address: '0x6b175474e89094c44da98b954eedeac495271d0f',
  symbol: 'DAI',
  decimals: 18,
};
const ETH: Token = { chain: 'evm:1', address: 'native', symbol: 'ETH', decimals: 18 };

const req: QuoteRequest = {
  sellToken: WETH,
  buyToken: DAI,
  sellAmount: 100n * 10n ** 18n,
  taker: USER,
  slippageBps: 50,
};

/** $1 per whole token, so USD cents = amount / 10^16 for 18-decimal tokens. */
const prices: PriceOracle = {
  usdValue: async (token, amount) => (amount * 100n) / 10n ** BigInt(token.decimals),
};

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
    expect(await provider.quote(req, AbortSignal.timeout(1000))).toEqual({
      provider: '0x',
      buyAmount: 454443538468285000000000n,
      minBuyAmount: 449892276190185000000000n,
      buyAmountUsd: 45444353n,
      gasCostUsd: 0n,
      route: [
        { protocol: 'Uniswap_V3', from: WETH.address, to: DAI.address, proportionBps: 7000 },
        { protocol: 'Curve', from: WETH.address, to: DAI.address, proportionBps: 3000 },
      ],
      tx: { to: ZEROX_ALLOWANCE_HOLDER, data: fixture.transaction.data, value: 0n },
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
    await expect(provider.quote(req, AbortSignal.timeout(1000))).rejects.toBeInstanceOf(
      NoLiquidityError,
    );
  });

  it('refuses routes that target an unexpected contract', async () => {
    const { provider } = setup({
      ...fixture,
      transaction: { ...fixture.transaction, to: '0x000000000000000000000000000000000000dead' },
    });
    await expect(provider.quote(req, AbortSignal.timeout(1000))).rejects.toBeInstanceOf(
      UnexpectedRouterError,
    );
  });

  it('rejects HTTP errors and malformed responses', async () => {
    await expect(setup({}, 500).provider.quote(req, AbortSignal.timeout(1000))).rejects.toThrow(
      '0x returned 500',
    );
    await expect(
      setup({ ...fixture, buyAmount: '-1' }).provider.quote(req, AbortSignal.timeout(1000)),
    ).rejects.toThrow();
  });
});

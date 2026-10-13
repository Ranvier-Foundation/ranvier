import { knownDecimals, listTokens, TOKEN_LIST } from '@ranvier/chains';
import { describe, expect, it } from 'vitest';
import { buildRoutePolicy } from '../domain/route-policy.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import { ALLOWANCE_HOLDER, SETTLER } from '../testing/zero-x-route.js';
import { LIST_CACHE_CONTROL, servedChains, type ChainView, type TokenView } from './lists.js';
import { buildServer, type ServerDeps } from './server.js';

const POLICY = buildRoutePolicy({
  1: [{ kind: 'zerox-allowance-holder', address: ALLOWANCE_HOLDER, targets: [SETTLER] }],
  8453: [{ kind: 'zerox-allowance-holder', address: ALLOWANCE_HOLDER, targets: [SETTLER] }],
});
const provider: QuoteProvider = {
  name: 'fake',
  supports: () => true,
  quote: async () => {
    throw new Error('lists never quote');
  },
};
const routing: Partial<ServerDeps> = {
  providers: [provider],
  prices: {
    price: async () => {
      throw new Error('lists never price');
    },
  },
  history: { hasCompletedSwap: async () => true },
  routePolicy: POLICY,
};

const get = (url: string, deps: Partial<ServerDeps> = {}) =>
  buildServer({ providers: [], servedChainIds: [1, 8453, 42161], ...deps }).inject({
    method: 'GET',
    url,
  });

const tokens = async (url: string): Promise<TokenView[]> => {
  const res = await get(url);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<TokenView[]>();
};

describe('GET /v1/chains', () => {
  it('lists the served registry chains with public fields only', async () => {
    const res = await get('/v1/chains', routing);
    expect(res.statusCode).toBe(200);
    expect(LIST_CACHE_CONTROL).toBe('private, max-age=300');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.json()).toEqual([
      {
        key: 'evm:1',
        name: 'Ethereum',
        family: 'evm',
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        explorer: 'https://etherscan.io',
        quoting: true,
      },
      {
        key: 'evm:8453',
        name: 'Base',
        family: 'evm',
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        explorer: 'https://basescan.org',
        quoting: true,
      },
      {
        // Served, but no trusted router for it in this policy: listed, not quoting.
        key: 'evm:42161',
        name: 'Arbitrum One',
        family: 'evm',
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        explorer: 'https://arbiscan.io',
        quoting: false,
      },
    ]);
    expect(res.body).not.toMatch(/defillama|stablecoins|knownDecimals|wrappedNative/i);
  });

  it('flags every chain as not quoting when routing is not configured', async () => {
    const chains = (await get('/v1/chains')).json<ChainView[]>();
    expect(chains.map((c) => [c.key, c.quoting])).toEqual([
      ['evm:1', false],
      ['evm:8453', false],
      ['evm:42161', false],
    ]);
  });

  it('skips served chain IDs that are not in the registry, and lists none by default', async () => {
    expect(servedChains({ servedChainIds: [84532, 8453], quoting: () => true })).toEqual([
      expect.objectContaining({ key: 'evm:8453', quoting: true }),
    ]);
    const res = await buildServer({ providers: [] }).inject({ method: 'GET', url: '/v1/chains' });
    expect(res.json()).toEqual([]);
  });
});

describe('GET /v1/tokens', () => {
  it('returns the curated list of a chain in display order, with cache headers', async () => {
    const res = await get('/v1/tokens?chain=evm:1');
    expect(res.headers['cache-control']).toBe(LIST_CACHE_CONTROL);
    const list = res.json<TokenView[]>();
    expect(list.map((t) => t.symbol)).toEqual(listTokens('evm:1').map((t) => t.symbol));
    expect(list.slice(0, 4).map((t) => t.symbol)).toEqual(['ETH', 'DAI', 'USDC', 'USDT']);
    expect(list[0]).toEqual({
      chain: 'evm:1',
      address: 'native',
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      tags: ['native'],
    });
    expect(list.find((t) => t.symbol === 'WBTC')).toEqual({
      chain: 'evm:1',
      address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
      symbol: 'WBTC',
      name: 'Wrapped BTC',
      decimals: 8,
      tags: [],
    });
  });

  it('never serves verification-only fields (onchainSymbol, bridge, bridgeExemption)', async () => {
    // The list entries carry them, so the absence below is the API's doing.
    const usdt0Entry = TOKEN_LIST.find((t) => t.chain === 'evm:42161' && t.symbol === 'USDT0');
    const baseDaiEntry = TOKEN_LIST.find((t) => t.chain === 'evm:8453' && t.symbol === 'DAI');
    const arbDaiEntry = TOKEN_LIST.find((t) => t.chain === 'evm:42161' && t.symbol === 'DAI');
    expect(usdt0Entry?.onchainSymbol).toBe('USD₮0');
    expect(baseDaiEntry?.bridge).toBeDefined();
    expect(arbDaiEntry?.bridgeExemption).toBeDefined();

    const arb = await tokens('/v1/tokens?chain=evm:42161&limit=100');
    expect(arb.find((t) => t.symbol === 'USDT0')).toEqual({
      chain: 'evm:42161',
      address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      symbol: 'USDT0',
      name: 'USD₮0',
      decimals: 6,
      tags: ['stablecoin'],
    });
    expect(arb.find((t) => t.symbol === 'DAI')).toEqual({
      chain: 'evm:42161',
      address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      tags: ['stablecoin', 'bridged'],
    });
    const base = await tokens('/v1/tokens?chain=evm:8453&limit=100');
    expect(base.find((t) => t.symbol === 'DAI')).toEqual({
      chain: 'evm:8453',
      address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      tags: ['stablecoin', 'bridged'],
    });
    for (const body of [JSON.stringify(arb), JSON.stringify(base)]) {
      expect(body).not.toMatch(
        /"(onchainSymbol|bridge|bridgeExemption|l1Address|gateway|ward|reason)":/,
      );
      expect(body).not.toMatch(/0x467194771dae2967aef3ecbedd3bf9a310c76c65/);
    }
  });

  it('serves decimals equal to the trusted knownDecimals for every listed token', async () => {
    let served = 0;
    for (const chain of ['evm:1', 'evm:8453', 'evm:42161'] as const) {
      for (const t of await tokens(`/v1/tokens?chain=${chain}&limit=100`)) {
        expect(t.decimals, `${chain} ${t.symbol}`).toBe(knownDecimals(chain, t.address));
        served += 1;
      }
    }
    expect(served).toBe(TOKEN_LIST.length);
  });

  it('searches symbols and names case-insensitively', async () => {
    expect((await tokens('/v1/tokens?chain=evm:1&q=uSdC')).map((t) => t.symbol)).toEqual(['USDC']);
    expect((await tokens('/v1/tokens?chain=evm:1&q=WRAPPED')).map((t) => t.symbol)).toEqual([
      'cbBTC',
      'WBTC',
      'WETH',
    ]);
    expect((await tokens('/v1/tokens?chain=evm:8453&q=aerodrome')).map((t) => t.symbol)).toEqual([
      'AERO',
    ]);
    expect(
      (await tokens(`/v1/tokens?chain=evm:42161&q=${encodeURIComponent('USD₮')}`)).map(
        (t) => t.symbol,
      ),
    ).toEqual(['USDT0']);
    expect((await tokens('/v1/tokens?chain=evm:1&q=dai%20stable')).map((t) => t.symbol)).toEqual([
      'DAI',
    ]);
  });

  it('finds a token by its exact address in mixed case, never by a prefix', async () => {
    const mixed = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(await tokens(`/v1/tokens?chain=evm:1&q=${mixed}`)).toEqual([
      expect.objectContaining({ symbol: 'USDC', address: mixed.toLowerCase() }),
    ]);
    expect(await tokens('/v1/tokens?chain=evm:1&q=0xa0b86991')).toEqual([]);
    expect(await tokens(`/v1/tokens?chain=evm:8453&q=${mixed}`)).toEqual([]);
  });

  it('applies the limit (default 50, at most 100)', async () => {
    expect(await tokens('/v1/tokens?chain=evm:1&limit=2')).toEqual([
      expect.objectContaining({ symbol: 'ETH' }),
      expect.objectContaining({ symbol: 'DAI' }),
    ]);
    expect(await tokens('/v1/tokens?chain=evm:1&limit=100')).toHaveLength(
      listTokens('evm:1').length,
    );
    for (const limit of ['0', '101', '-1', '1.5', '1e1', '01', 'x', '', '9999']) {
      const res = await get(`/v1/tokens?chain=evm:1&limit=${limit}`);
      expect(res.statusCode, limit).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request', fields: ['limit'] });
    }
  });

  it('returns an empty list for a registry chain without a curated list', async () => {
    expect(await tokens('/v1/tokens?chain=solana:mainnet')).toEqual([]);
  });

  it('refuses unknown, missing and malformed chains with field paths only', async () => {
    for (const url of [
      '/v1/tokens?chain=evm:5',
      '/v1/tokens?chain=evm:01',
      '/v1/tokens?chain=evm:999999',
      '/v1/tokens?chain=ethereum',
      '/v1/tokens?chain=evm:1&chain=evm:8453',
      '/v1/tokens',
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toEqual({ error: 'invalid_request', fields: ['chain'] });
      expect(res.headers['cache-control'], url).toBeUndefined();
    }
  });

  it('refuses malformed and oversize queries without echoing them', async () => {
    const probes = [
      '<script>alert(1)</script>',
      'usdc;drop',
      "usdc'",
      'a\u0000b',
      'line\nbreak',
      'q'.repeat(65),
    ];
    for (const q of probes) {
      const res = await get(`/v1/tokens?chain=evm:1&q=${encodeURIComponent(q)}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request', fields: ['q'] });
      expect(res.body).not.toContain(q.slice(0, 10));
    }
    // 64 characters is the longest accepted query.
    expect(await tokens(`/v1/tokens?chain=evm:1&q=${'q'.repeat(64)}`)).toEqual([]);
    const repeated = await get('/v1/tokens?chain=evm:1&q=usdc&q=dai');
    expect(repeated.json()).toEqual({ error: 'invalid_request', fields: ['q'] });
  });

  it('refuses unknown parameters', async () => {
    const res = await get('/v1/tokens?chain=evm:1&decimals=6');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request', fields: ['(body)'] });
  });

  it('never calls providers or the price oracle', async () => {
    const res = await get('/v1/tokens?chain=evm:1', routing);
    expect(res.statusCode).toBe(200);
  });
});

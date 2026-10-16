/**
 * ADR 0013, section 2: the `ChainCatalog` behind the list, balance and direct-wrap routes.
 *
 * - Production (`buildServer`) serves the registry and nothing else: it refuses a catalog, and a
 *   balance service built on another catalog; 31337 in `servedChainIds` is never listed.
 * - `buildServer` and `buildServerWithCatalog(REGISTRY_CATALOG)` answer byte for byte the same.
 * - A wider catalog may add only local or test chains, leaves every registry chain unchanged,
 *   and cannot reach the fee schedule or the real price oracle.
 *
 * The extra chain here is an inline stand-in for the harness chain (no harness data: production
 * sources may not hold it).
 */
import {
  CHAINS,
  listTokens,
  TOKEN_LIST,
  type ChainConfig,
  type CuratedToken,
} from '@ranvier/chains';
import { quoteFee } from '@ranvier/fees';
import type { ChainKey, TokenRef } from '@ranvier/types';
import type { InjectOptions } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { DefiLlamaPriceOracle } from './adapters/prices/defillama.js';
import {
  assertCatalogExtendsRegistry,
  ChainCatalogError,
  REGISTRY_CATALOG,
  searchCatalog,
  type ChainCatalog,
} from './chain-catalog.js';
import { BalanceService } from './domain/balances.js';
import { buildRoutePolicy } from './domain/route-policy.js';
import { buildDirectWrap } from './domain/wrap.js';
import { buildServer, buildServerWithCatalog, type ServerDeps } from './http/server.js';
import type { BalancesRead, BalancesRequest, ChainReader } from './ports/chain-reader.js';
import { ALLOWANCE_HOLDER, SETTLER } from './testing/zero-x-route.js';

const LOCAL_KEY = 'evm:31337' satisfies ChainKey;
const WRAPPED = '0x00000000000000000000000000000000000a11ce';
const DOLLAR = '0x00000000000000000000000000000000000b0b00';

const localTokens: CuratedToken[] = [
  {
    chain: LOCAL_KEY,
    address: 'native',
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    tags: ['native'],
  },
  { chain: LOCAL_KEY, address: DOLLAR, symbol: 'tUSD', name: 'Test Dollar', decimals: 6 },
  {
    chain: LOCAL_KEY,
    address: WRAPPED,
    symbol: 'tWETH',
    name: 'Test Wrapped Ether',
    decimals: 18,
    tags: ['wrapped-native'],
  },
];

function localChain(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    key: LOCAL_KEY,
    family: 'evm',
    name: 'Inline test chain',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: WRAPPED,
    stablecoins: {},
    knownDecimals: { [WRAPPED]: 18, [DOLLAR]: 6 },
    explorer: '',
    defillama: '',
    ...overrides,
  };
}

/** The registry plus `extra` chains with their tokens, the shape the harness entry builds. */
function extend(
  extra: readonly ChainConfig[],
  tokens: readonly CuratedToken[] = localTokens,
  base: ChainCatalog = REGISTRY_CATALOG,
): ChainCatalog {
  return {
    chains: [...base.chains, ...extra],
    getChain: (key) => base.getChain(key) ?? extra.find((c) => c.key === key),
    listTokens: (key) =>
      extra.some((c) => c.key === key)
        ? tokens.filter((t) => t.chain === key)
        : base.listTokens(key),
  };
}

const POLICY = buildRoutePolicy({
  1: [{ kind: 'zerox-allowance-holder', address: ALLOWANCE_HOLDER, targets: [SETTLER] }],
  31337: [{ kind: 'zerox-allowance-holder', address: ALLOWANCE_HOLDER, targets: [SETTLER] }],
});

class StubReader implements ChainReader {
  canRead(): boolean {
    return true;
  }
  readBalances(req: BalancesRequest): Promise<BalancesRead> {
    return Promise.resolve({
      blockNumber: 7n,
      native: 10n ** 18n,
      tokens: req.tokens.map((_t, i) => BigInt(i + 1)),
    });
  }
}

const SERVED = [1, 8453, 42161, 31337];

function deps(catalog: ChainCatalog = REGISTRY_CATALOG): ServerDeps {
  return {
    providers: [
      { name: 'none', supports: () => false, quote: () => Promise.reject(new Error('no')) },
    ],
    prices: { price: () => Promise.reject(new Error('no price')) },
    history: { hasCompletedSwap: () => Promise.resolve(true) },
    routePolicy: POLICY,
    servedChainIds: SERVED,
    webOrigins: ['https://app.example'],
    balances: {
      service: new BalanceService({ reader: new StubReader(), servedChainIds: SERVED, catalog }),
      deadlineMs: 500,
    },
  };
}

describe('REGISTRY_CATALOG is the registry, unchanged', () => {
  it('chains, getChain and listTokens are the registry values', () => {
    expect(REGISTRY_CATALOG.chains).toBe(CHAINS);
    for (const c of CHAINS) {
      expect(REGISTRY_CATALOG.getChain(c.key)).toBe(c);
      expect(REGISTRY_CATALOG.listTokens(c.key)).toEqual(listTokens(c.key));
    }
    expect(REGISTRY_CATALOG.getChain(LOCAL_KEY)).toBeUndefined();
    expect(Object.isFrozen(REGISTRY_CATALOG)).toBe(true);
    expect(() => assertCatalogExtendsRegistry(REGISTRY_CATALOG)).not.toThrow();
  });

  it('searchCatalog equals the registry search for every chain and query', async () => {
    const { searchTokens } = await import('@ranvier/chains');
    for (const c of CHAINS) {
      for (const q of ['', 'us', 'USDC', 'e', 'wrapped', TOKEN_LIST[1]?.address ?? '', '0x12']) {
        expect(searchCatalog(REGISTRY_CATALOG, c.key, q, 50)).toEqual(searchTokens(c.key, q, 50));
      }
    }
  });
});

describe('assertCatalogExtendsRegistry refuses anything but registry + local or test chains', () => {
  it('accepts the registry plus a local chain', () => {
    expect(() => assertCatalogExtendsRegistry(extend([localChain()]))).not.toThrow();
    expect(() =>
      assertCatalogExtendsRegistry(extend([localChain({ key: 'evm:84532' })], [])),
    ).not.toThrow();
  });

  it.each<[string, () => ChainCatalog, string]>([
    [
      'a mainnet added',
      () => extend([localChain({ key: 'evm:10' })], []),
      'not a local or test chain',
    ],
    [
      'an unknown chain added',
      () => extend([localChain({ key: 'evm:999' })], []),
      'not a local or test chain',
    ],
    [
      'a registry chain added twice',
      () => ({ ...REGISTRY_CATALOG, chains: [...CHAINS, CHAINS[1] as ChainConfig] }),
      'extra chain evm:8453 is not a local or test chain',
    ],
    [
      'a non-canonical key',
      () => extend([localChain({ key: 'evm:031337' as ChainKey })], []),
      'not a canonical EVM chain',
    ],
    [
      'a Solana extra',
      () => extend([localChain({ family: 'solana' })], []),
      'not a canonical EVM chain',
    ],
    ['the local chain twice', () => extend([localChain(), localChain()]), 'listed twice'],
    [
      'stablecoins on the extra chain',
      () => extend([localChain({ stablecoins: { tUSD: DOLLAR } })]),
      'lists stablecoins',
    ],
    [
      "another chain's token",
      () => {
        const c = extend([localChain()]);
        return {
          ...c,
          listTokens: (k) => (k === LOCAL_KEY ? listTokens('evm:1') : c.listTokens(k)),
        };
      },
      "lists another chain's token",
    ],
    [
      'getChain disagreeing with chains',
      () => ({ ...extend([localChain()]), getChain: REGISTRY_CATALOG.getChain }),
      'getChain(evm:31337) disagrees',
    ],
    [
      'a registry chain replaced',
      () => ({
        ...REGISTRY_CATALOG,
        chains: [{ ...(CHAINS[0] as ChainConfig) }, ...CHAINS.slice(1)],
      }),
      'registry chain evm:1 is not unchanged',
    ],
    [
      'a registry chain dropped',
      () => ({ ...REGISTRY_CATALOG, chains: CHAINS.slice(1) }),
      'registry chain evm:1 is not unchanged',
    ],
    [
      'getChain of a registry chain replaced',
      () => {
        const fake = { ...(CHAINS[0] as ChainConfig), stablecoins: { WETH: '0x00' } };
        return {
          ...REGISTRY_CATALOG,
          getChain: (k) => (k === 'evm:1' ? fake : REGISTRY_CATALOG.getChain(k)),
        };
      },
      'getChain(evm:1) is not the registry',
    ],
    [
      'a registry token list changed',
      () => ({
        ...REGISTRY_CATALOG,
        listTokens: (k) => (k === 'evm:8453' ? listTokens('evm:8453').slice(1) : listTokens(k)),
      }),
      'the token list of evm:8453',
    ],
  ])('%s', (_name, make, message) => {
    expect(() => assertCatalogExtendsRegistry(make())).toThrow(ChainCatalogError);
    expect(() => assertCatalogExtendsRegistry(make())).toThrow(message);
  });
});

describe('production buildServer serves the registry only', () => {
  it('refuses a catalog passed in (only possible through a cast)', () => {
    const harnessShaped = { ...deps(), catalog: extend([localChain()]) };
    expect(() => buildServer(harnessShaped as unknown as ServerDeps)).toThrow(
      'buildServer serves the registry only and takes no chain catalog',
    );
    const registry = { ...deps(), catalog: REGISTRY_CATALOG };
    expect(() => buildServer(registry as unknown as ServerDeps)).toThrow(ChainCatalogError);
  });

  it('refuses a balance service built on another catalog', () => {
    expect(() => buildServer(deps(extend([localChain()])))).toThrow(
      'the balance service was built on another chain catalog',
    );
  });

  it('never lists 31337, even served and with a router policy for it', async () => {
    const app = buildServer(deps());
    const chains = (await app.inject({ method: 'GET', url: '/v1/chains' })).json<
      { key: string }[]
    >();
    expect(chains.map((c) => c.key)).toEqual(['evm:1', 'evm:8453', 'evm:42161']);
    const tokens = await app.inject({ method: 'GET', url: '/v1/tokens?chain=evm:31337' });
    expect(tokens.statusCode).toBe(400);
    expect(tokens.json()).toEqual({ error: 'invalid_request', fields: ['chain'] });
    const balances = await app.inject({
      method: 'POST',
      url: '/v1/balances',
      headers: { 'content-type': 'application/json' },
      payload: { chain: 'evm:31337', address: '0x00000000000000000000000000000000000000aa' },
    });
    expect(balances.statusCode).toBe(400);
  });
});

/** Every list, balance, wrap and error answer the server gives, as raw status, headers and body. */
async function answers(app: ReturnType<typeof buildServer>): Promise<string[]> {
  const origin = { origin: 'https://app.example' };
  const requests: InjectOptions[] = [
    { method: 'GET', url: '/v1/chains', headers: origin },
    { method: 'GET', url: '/v1/tokens?chain=evm:1' },
    { method: 'GET', url: '/v1/tokens?chain=evm:8453&q=us&limit=3' },
    {
      method: 'GET',
      url: '/v1/tokens?chain=evm:42161&q=0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    },
    { method: 'GET', url: '/v1/tokens?chain=solana:mainnet' },
    { method: 'GET', url: '/v1/tokens?chain=evm:31337' },
    { method: 'GET', url: '/v1/tokens?chain=evm:84532' },
    { method: 'GET', url: '/v1/balances' },
    ...['evm:1', 'evm:8453', 'evm:31337', 'evm:84532'].map((chain) => ({
      method: 'POST',
      url: '/v1/balances',
      headers: { 'content-type': 'application/json', ...origin },
      payload: JSON.stringify({ chain, address: '0x00000000000000000000000000000000000000aa' }),
    })),
    ...[
      ['evm:1', 'native', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
      ['evm:8453', '0x4200000000000000000000000000000000000006', 'native'],
      ['evm:31337', 'native', WRAPPED],
      ['evm:1', 'native', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
    ].map(([chain, sell, buy]) => ({
      method: 'POST',
      url: '/v1/quotes',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        sellToken: { chain, address: sell },
        buyToken: { chain, address: buy },
        sellAmount: '1000',
        taker: '0x00000000000000000000000000000000000000aa',
        slippageBps: 50,
      }),
    })),
  ];
  const out: string[] = [];
  for (const r of requests) {
    const res = await app.inject(r);
    const headers = { ...res.headers };
    delete headers.date; // the one value that differs between any two answers
    out.push(`${r.method} ${r.url} -> ${res.statusCode} ${JSON.stringify(headers)} ${res.body}`);
  }
  return out;
}

describe('byte identity', () => {
  it('buildServer and buildServerWithCatalog(REGISTRY_CATALOG) answer exactly alike', async () => {
    const a = await answers(buildServer(deps()));
    const b = await answers(buildServerWithCatalog(deps(), REGISTRY_CATALOG));
    expect(b).toEqual(a);
    expect(a.length).toBe(16);
  });

  it('a wider catalog changes no registry answer, only adds its own chain', async () => {
    const wide = extend([localChain()]);
    const a = await answers(buildServer(deps()));
    const b = await answers(buildServerWithCatalog(deps(wide), wide));
    const differs = a.map((line, i) => (line === b[i] ? null : i)).filter((i) => i !== null);
    // /v1/chains (the extra chain listed), its tokens, and its balances; nothing else.
    expect(differs).toEqual([0, 5, 10]);
    expect(b[0]).toContain('"key":"evm:31337"');
    expect(b[5]).toContain('"symbol":"tUSD"');
    expect(b[10]).toMatch(/-> 200 .*"chain":"evm:31337"/);
    // The wrap pair on the extra chain is never a direct wrap: the fee schedule decides.
    // It goes down the routed path (here: no price), never the direct-wrap answer.
    expect(b[14]).toMatch(/-> 503 .*"price_unavailable"/);
    expect(b[14]).not.toContain('"direct"');
  });
});

describe('a catalog cannot reach the fee schedule or the real oracle', () => {
  const wide = extend([localChain()]);
  const local = (address: string): TokenRef => ({ chain: LOCAL_KEY, address });

  it('no direct wrap on a chain outside the registry, whatever the catalog says', () => {
    const request = { sellToken: local('native'), buyToken: local(WRAPPED), sellAmount: 1n };
    expect(buildDirectWrap(request, wide)).toBeUndefined();
    expect(buildDirectWrap(request)).toBeUndefined();
  });

  it('the fee schedule never sees the extra chain: no stablecoin rate, no free wrap', () => {
    const base = { usdValue: 100_00n, isFirstSwap: false, sellAmount: 10n ** 6n };
    expect(quoteFee({ ...base, sellToken: local(DOLLAR), buyToken: local(DOLLAR) }).reason).toBe(
      'tier-under-10k',
    );
    expect(quoteFee({ ...base, sellToken: local('native'), buyToken: local(WRAPPED) }).bps).toBe(
      20,
    );
  });

  it('DefiLlama is never asked about a chain outside the registry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const oracle = new DefiLlamaPriceOracle({ fetch });
    for (const address of ['native', DOLLAR]) {
      await expect(oracle.price(local(address), AbortSignal.timeout(1_000))).rejects.toThrow(
        'unknown chain evm:31337',
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

import type { Page, Route } from '@playwright/test';
import { ACCOUNT_A } from './wallet-fixture';

/**
 * A stand-in for the Ranvier API, answered from the test (`page.route`), so no test needs a server
 * or the network. The web build bakes the API origin at build time (NEXT_PUBLIC_API_URL; `pnpm e2e`
 * and CI set it to the default below, and playwright.config.ts uses the same default).
 * The mock answers like the real API (ADR 0006, ADR 0009): JSON, CORS for the page's origin,
 * `Cache-Control` as documented. Everything the page asks is logged, so tests can assert what was
 * sent (and what was not).
 */
export const DEFAULT_API_URL = 'http://127.0.0.1:3199';
export const API_ORIGIN = new URL(process.env['NEXT_PUBLIC_API_URL'] ?? DEFAULT_API_URL).origin;

export type ChainKey = 'evm:1' | 'evm:8453' | 'evm:42161';

export interface ChainFixture {
  key: ChainKey;
  name: string;
  family: 'evm';
  nativeSymbol: string;
  nativeDecimals: number;
  explorer: string;
  quoting: boolean;
  balances: boolean;
}

export interface TokenFixture {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  tags: string[];
}

export const CHAINS: ChainFixture[] = [
  chain('evm:1', 'Ethereum'),
  chain('evm:8453', 'Base'),
  chain('evm:42161', 'Arbitrum One'),
];

function chain(key: ChainKey, name: string): ChainFixture {
  return {
    key,
    name,
    family: 'evm',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorer: 'https://explorer.example',
    quoting: true,
    balances: true,
  };
}

const USDC: Record<ChainKey, string> = {
  'evm:1': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  'evm:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'evm:42161': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
};
export const DAI_ETHEREUM = '0x6b175474e89094c44da98b954eedeac495271d0f';
export const WETH_ETHEREUM = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const ARB = '0x912ce59144191c1204e64559fe8253a0e49e6548';

function tokensOf(key: ChainKey): TokenFixture[] {
  const t = (address: string, symbol: string, name: string, decimals: number, tags: string[]) => ({
    chain: key,
    address,
    symbol,
    name,
    decimals,
    tags,
  });
  const list = [
    t('native', 'ETH', 'Ether', 18, ['native']),
    t(USDC[key], 'USDC', 'USD Coin', 6, ['stablecoin']),
  ];
  if (key === 'evm:1') {
    list.push(t(DAI_ETHEREUM, 'DAI', 'Dai Stablecoin', 18, ['stablecoin']));
    list.push(t(WETH_ETHEREUM, 'WETH', 'Wrapped Ether', 18, ['wrapped-native']));
  }
  if (key === 'evm:42161') list.push(t(ARB, 'ARB', 'Arbitrum', 18, []));
  return list;
}

export const TOKENS: Record<ChainKey, TokenFixture[]> = {
  'evm:1': tokensOf('evm:1'),
  'evm:8453': tokensOf('evm:8453'),
  'evm:42161': tokensOf('evm:42161'),
};

/** Wallet balances in base units, by chain and token symbol. Missing means zero. */
export const BALANCES: Record<ChainKey, Record<string, string>> = {
  'evm:1': { ETH: '84100000000000000', USDC: '2410500000' },
  'evm:8453': { ETH: '1500000000000000000', USDC: '640000000' },
  'evm:42161': {},
};

/** A request the page made to the API. */
export interface ApiRequest {
  method: string;
  path: string;
  search: string;
  /** Parsed JSON body of a POST, if any. */
  body: unknown;
  headers: Record<string, string>;
}

/** What the mock sends back. */
export interface Reply {
  status?: number;
  json?: unknown;
  /** Raw body instead of `json` (for malformed answers). */
  raw?: string;
  contentType?: string;
  delayMs?: number;
  /** Fail the request at the network level. */
  abort?: boolean;
}

export type Override = (req: ApiRequest) => Reply | undefined;

export class MockApi {
  readonly requests: ApiRequest[] = [];
  /** Error statuses this test asked for on purpose; the shared page checks let them pass. */
  readonly provoked = new Set<number>();
  /** Requests this test made fail at the network level on purpose. */
  aborts = 0;
  private overrides: Override[] = [];

  /** Adds an override, tried before the defaults (the last one added is tried first). */
  override(fn: Override): void {
    this.overrides.unshift(fn);
  }

  /** Requests to `/v1/<name>`, optionally narrowed by method. */
  calls(name: 'chains' | 'tokens' | 'balances', method?: string): ApiRequest[] {
    return this.requests.filter(
      (r) => r.path === `/v1/${name}` && (method === undefined || r.method === method),
    );
  }

  private fallback(req: ApiRequest): Reply {
    const params = new URLSearchParams(req.search);
    if (req.path === '/v1/chains' && req.method === 'GET') return { json: CHAINS };
    if (req.path === '/v1/tokens' && req.method === 'GET') {
      const key = params.get('chain') as ChainKey | null;
      const q = (params.get('q') ?? '').toLowerCase();
      const list = key && TOKENS[key] ? TOKENS[key] : [];
      return {
        json: list.filter(
          (tk) =>
            q === '' ||
            tk.symbol.toLowerCase().includes(q) ||
            (q.length >= 2 && tk.name.toLowerCase().includes(q)) ||
            tk.address === q,
        ),
      };
    }
    if (req.path === '/v1/balances' && req.method === 'POST') {
      const body = req.body as { chain: ChainKey; address: string };
      const held = BALANCES[body.chain] ?? {};
      return {
        json: {
          chain: body.chain,
          address: body.address.toLowerCase(),
          blockNumber: '12345',
          balances: (TOKENS[body.chain] ?? []).map((tk) => ({
            address: tk.address,
            balance: held[tk.symbol] ?? '0',
          })),
        },
      };
    }
    return { status: 404, json: { error: 'not_found' } };
  }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const origin = request.headers()['origin'] ?? '*';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors }).catch(() => {});
      return;
    }
    const url = new URL(request.url());
    let body: unknown;
    const raw = request.postData();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const req: ApiRequest = {
      method: request.method(),
      path: url.pathname,
      search: url.search,
      body,
      headers: request.headers(),
    };
    this.requests.push(req);
    let reply: Reply | undefined;
    for (const fn of this.overrides) {
      reply = fn(req);
      if (reply) break;
    }
    // An override that only sets a delay (or a status) keeps the normal answer's body.
    reply =
      !reply ||
      (reply.json === undefined &&
        reply.raw === undefined &&
        !reply.abort &&
        reply.status === undefined)
        ? { ...this.fallback(req), ...reply }
        : reply;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    const status = reply.status ?? 200;
    if (status >= 400) this.provoked.add(status);
    const noStore = req.path === '/v1/balances';
    try {
      if (reply.abort) {
        this.aborts++;
        await route.abort('failed');
      } else {
        await route.fulfill({
          status,
          headers: {
            ...cors,
            'content-type': reply.contentType ?? 'application/json',
            'cache-control': noStore ? 'private, no-store' : 'private, max-age=300',
          },
          body: reply.raw ?? JSON.stringify(reply.json ?? {}),
        });
      }
    } catch {
      /* the page aborted the request while the mock was waiting */
    }
  }
}

export async function installApi(page: Page): Promise<MockApi> {
  const api = new MockApi();
  await page.route(`${API_ORIGIN}/**`, (route) => api.handle(route));
  return api;
}

/** The wallet address the fixture wallet connects with, as the API receives it. */
export const WALLET = ACCOUNT_A;

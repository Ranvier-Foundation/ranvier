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

/**
 * The body of a `POST /v1/balances` answer. `held` is the wallet's balances by token symbol;
 * with none, the wallet holds nothing on that chain.
 */
export function balancesAnswer(
  chain: ChainKey,
  address: string,
  held: Record<string, string> = {},
): unknown {
  return {
    chain,
    address: address.toLowerCase(),
    blockNumber: '12345',
    balances: (TOKENS[chain] ?? []).map((tk) => ({
      address: tk.address,
      balance: held[tk.symbol] ?? '0',
    })),
  };
}

/** What the stand-in quote answer is made of. All of it is test data, not a model of the real API. */
export interface QuoteSettings {
  /** Seconds the signed quote is valid for, counted from the moment the mock answers. */
  ttlSec: number;
  /** Added to the deadline: a device clock that is behind (positive) or ahead (negative) of the API's. */
  deadlineSkewSec?: number;
  /** How many routes the answer says it compared. */
  routes: number;
  /** The wallet has never swapped: the first $1,000 is free. */
  firstSwap: boolean;
  /** Extra or replaced fields, for the strict-validator tests (a mismatch must refuse the answer). */
  tamper?: (answer: Record<string, unknown>) => void;
  /** Called with every request body the mock answered. */
  answered?: (body: QuoteBody) => void;
}

export interface QuoteBody {
  sellToken: { chain: ChainKey; address: string };
  buyToken: { chain: ChainKey; address: string };
  sellAmount: string;
  taker: string;
  slippageBps: number;
}

/** USD cents of one whole token in the mock's world. */
const PRICE_CENTS: Record<string, bigint> = { ETH: 250_000n, WETH: 250_000n, USDC: 100n, DAI: 100n, ARB: 100n };
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function tokenOf(t: { chain: ChainKey; address: string }): TokenFixture {
  const found = TOKENS[t.chain]?.find((x) => x.address === t.address);
  if (!found) throw new Error(`the mock does not know ${t.address} on ${t.chain}`);
  return found;
}

/**
 * Answers `POST /v1/quotes` like the real API's shape (apps/api/src/http/server.ts), with made-up
 * numbers: a fixed price per token, a 0.2% fee (0.05% between two stablecoins, free for a wrap, a
 * first-swap waiver on request), a $0.31 network cost and a 0.5% slippage floor. The answer also
 * carries what the web app must never keep (router calldata, signature, the signed transaction):
 * tests assert none of it reaches the page's storage, console or DOM.
 */
export function quoteReply(raw: unknown, settings: QuoteSettings): Reply {
  const body = raw as QuoteBody;
  settings.answered?.(body);
  const sell = tokenOf(body.sellToken);
  const buy = tokenOf(body.buyToken);
  const sellAmount = BigInt(body.sellAmount);
  const wrapPair =
    body.sellToken.chain === body.buyToken.chain &&
    ((sell.address === 'native' && buy.symbol === 'WETH') ||
      (buy.address === 'native' && sell.symbol === 'WETH'));
  if (wrapPair) {
    const wrap = sell.address === 'native';
    return {
      json: {
        fee: { bps: 0, reason: 'wrap-unwrap', amount: '0', waivedUsd: '0' },
        direct: {
          kind: wrap ? 'wrap' : 'unwrap',
          transaction: { to: WETH_ETHEREUM, data: '0xd0e30db0', value: wrap ? body.sellAmount : '0' },
          buyAmount: body.sellAmount,
          minBuyAmount: body.sellAmount,
        },
      },
    };
  }
  const sellPrice = PRICE_CENTS[sell.symbol] ?? 100n;
  const buyPrice = PRICE_CENTS[buy.symbol] ?? 100n;
  const sellUsd = (sellAmount * sellPrice) / 10n ** BigInt(sell.decimals);
  const stable = sell.tags.includes('stablecoin') && buy.tags.includes('stablecoin');
  const bps = stable ? 5n : 20n;
  const tier = stable ? 'stablecoin' : 'tier-under-10k';
  let feeAmount = (sellAmount * bps) / 10_000n;
  let reason: string = tier;
  let waivedUsd = 0n;
  if (settings.firstSwap) {
    waivedUsd = sellUsd < 100_000n ? sellUsd : 100_000n;
    reason = 'first-swap-promo';
    feeAmount = sellUsd <= 100_000n ? 0n : (((sellAmount * (sellUsd - 100_000n)) / sellUsd) * bps) / 10_000n;
  }
  const net = sellAmount - feeAmount;
  const buyAmount = (net * sellPrice * 10n ** BigInt(buy.decimals)) / (10n ** BigInt(sell.decimals) * buyPrice);
  const minBuyAmount = (buyAmount * 9_950n + 9_999n) / 10_000n;
  const buyAmountUsd = (buyAmount * buyPrice) / 10n ** BigInt(buy.decimals);
  const deadline = Math.floor(Date.now() / 1000) + settings.ttlSec + (settings.deadlineSkewSec ?? 0);
  const best = {
    provider: '0x',
    buyAmount: buyAmount.toString(),
    minBuyAmount: minBuyAmount.toString(),
    gasCostUsd: '31',
    buyAmountUsd: buyAmountUsd.toString(),
    route: [{ protocol: 'Uniswap_V3', from: body.sellToken.address, to: body.buyToken.address, proportionBps: 10_000 }],
    tx: { to: '0x0000000000001ff3684f28c67538d4d072c22734', data: '0x2213bc0bdeadbeefROUTERCALLDATA', value: '0' },
  };
  const answer: Record<string, unknown> = {
    fee: { bps: Number(bps), reason, amount: feeAmount.toString(), waivedUsd: waivedUsd.toString() },
    best,
    quotes: Array.from({ length: settings.routes }, () => best),
    failures: [],
    swap: {
      quote: {
        user: body.taker.toLowerCase(),
        tokenIn: body.sellToken.address === 'native' ? ZERO_ADDRESS : body.sellToken.address,
        tokenOut: body.buyToken.address === 'native' ? ZERO_ADDRESS : body.buyToken.address,
        amountIn: body.sellAmount,
        minAmountOut: minBuyAmount.toString(),
        feeAmount: feeAmount.toString(),
        router: '0x0000000000001ff3684f28c67538d4d072c22734',
        routerCalldataHash: '0xSECRETCALLDATAHASH',
        nonce: '123456789',
        deadline: String(deadline),
      },
      signature: '0xSIGNATUREDONOTKEEP',
      transaction: { to: '0xFEEWRAPPER', data: '0xSIGNEDSWAPCALLDATA', value: '0' },
    },
  };
  settings.tamper?.(answer);
  return { json: answer };
}

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
  /**
   * Holds the answer until this promise settles (see `deferred`). A reply with only a gate keeps
   * the normal body, so a test holds an answer and releases it when it chooses, with no timer.
   */
  gate?: Promise<unknown>;
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
  /**
   * The same requests by URL: how many failures of each the browser may still log as a console
   * error (`net::ERR_FAILED`). The shared page checks use it so that only a failure the test
   * asked for is let through, not any failure that happens while a test provokes one.
   */
  readonly abortedUrls = new Map<string, number>();
  private overrides: Override[] = [];
  /** How the default `/v1/quotes` answer is made (see `quoteAnswer`). Change per test. */
  quoteSettings: QuoteSettings = { ttlSec: 60, routes: 3, firstSwap: false };

  /** Adds an override, tried before the defaults (the last one added is tried first). */
  override(fn: Override): void {
    this.overrides.unshift(fn);
  }

  /** Requests to `/v1/<name>`, optionally narrowed by method. */
  calls(name: 'chains' | 'tokens' | 'balances' | 'quotes', method?: string): ApiRequest[] {
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
      return { json: balancesAnswer(body.chain, body.address, BALANCES[body.chain]) };
    }
    if (req.path === '/v1/quotes' && req.method === 'POST') {
      return quoteReply(req.body, this.quoteSettings);
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
    if (reply.gate) await reply.gate;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    const status = reply.status ?? 200;
    if (status >= 400) this.provoked.add(status);
    const noStore = req.path === '/v1/balances';
    try {
      if (reply.abort) {
        this.aborts++;
        this.abortedUrls.set(request.url(), (this.abortedUrls.get(request.url()) ?? 0) + 1);
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

/** A promise the test settles by hand: `await`ed by the mock as a `gate`, released with `release()`. */
export function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** What `answersOutliveAbort` reports from the page. */
export interface OutliveAbort {
  /** How many complete answers the page has read from the API so far (all requests, ever). */
  count: () => Promise<number>;
  /** Resolves when the page has read `count` complete answers in all. */
  until: (count: number) => Promise<void>;
}

/**
 * Makes API answers reach the page's code even after the page aborted the request, the worst case
 * for stale data: the browser had already received the answer when the abort landed, or a client
 * resolved anyway. The page's own AbortController still flips to `aborted`, so only the guards in
 * the picker's hooks keep such an answer off the screen. Must run before the first navigation.
 */
export async function answersOutliveAbort(page: Page): Promise<OutliveAbort> {
  await page.addInitScript(
    ({ origin }) => {
      const w = window as unknown as { __apiAnswered: number };
      w.__apiAnswered = 0;
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const ours = url.startsWith(origin);
        // Drop the signal: the request is no longer cancellable from the page.
        const rest = ours && init ? { ...init, signal: null } : init;
        const res = await real(input, rest);
        if (ours) {
          void res
            .clone()
            .arrayBuffer()
            .then(
              () => (w.__apiAnswered += 1),
              () => {},
            );
        }
        return res;
      };
    },
    { origin: API_ORIGIN },
  );
  return {
    count: () =>
      page.evaluate(() => (window as unknown as { __apiAnswered?: number }).__apiAnswered ?? 0),
    until: async (count) => {
      await page.waitForFunction(
        (n) => (window as unknown as { __apiAnswered: number }).__apiAnswered >= n,
        count,
      );
    },
  };
}

export async function installApi(page: Page): Promise<MockApi> {
  const api = new MockApi();
  await page.route(`${API_ORIGIN}/**`, (route) => api.handle(route));
  return api;
}

/** The wallet address the fixture wallet connects with, as the API receives it. */
export const WALLET = ACCOUNT_A;

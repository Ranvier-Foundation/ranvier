import { describe, expect, it } from 'vitest';
import {
  ApiError,
  MAX_RESPONSE_CHARS,
  fetchBalances,
  fetchChains,
  fetchTokens,
  isAbort,
} from '../../src/lib/api/client';
import { SchemaError, parseBalances, parseChains, parseTokens } from '../../src/lib/api/schemas';

const ORIGIN = 'https://api.example';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WALLET = '0x7a3E1b2C9d4F5a60718293a4B5c6D7e8F9013F9c';

const chain = (over: Record<string, unknown> = {}) => ({
  key: 'evm:8453',
  name: 'Base',
  family: 'evm',
  nativeSymbol: 'ETH',
  nativeDecimals: 18,
  explorer: 'https://basescan.org',
  quoting: true,
  balances: true,
  ...over,
});
const token = (over: Record<string, unknown> = {}) => ({
  chain: 'evm:8453',
  address: USDC,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  tags: ['stablecoin'],
  ...over,
});

describe('parseChains', () => {
  it('keeps only what the app uses', () => {
    expect(parseChains([chain()])).toEqual([
      {
        key: 'evm:8453',
        name: 'Base',
        family: 'evm',
        nativeSymbol: 'ETH',
        balances: true,
        quoting: true,
      },
    ]);
  });
  it.each([
    ['not an array', {}],
    ['bad key', [chain({ key: 'evm:0' })]],
    ['key with a path', [chain({ key: 'evm:1/../x' })]],
    ['unknown family', [chain({ family: 'cosmos' })]],
    ['balances not a boolean', [chain({ balances: 'yes' })]],
    ['empty name', [chain({ name: '' })]],
    ['name with a bidi override', [chain({ name: 'Ba‮se' })]],
    ['duplicate key', [chain(), chain()]],
    ['too many', Array.from({ length: 65 }, (_, i) => chain({ key: `evm:${i + 1}` }))],
  ])('refuses %s', (_label, json) => {
    expect(() => parseChains(json)).toThrow(SchemaError);
  });
});

describe('parseTokens', () => {
  it('returns typed tokens and drops logoUri and unknown tags', () => {
    const [t] = parseTokens(
      [token({ logoUri: 'https://evil.example/x.png', tags: ['stablecoin', 'future-tag'] })],
      'evm:8453',
    );
    expect(t).toEqual({
      chain: 'evm:8453',
      address: USDC,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      tags: ['stablecoin'],
    });
    expect(t).not.toHaveProperty('logoUri');
  });
  it('accepts markup-looking text (it is only ever rendered as text)', () => {
    const [t] = parseTokens([token({ name: '<img src=x onerror=alert(1)>' })], 'evm:8453');
    expect(t?.name).toBe('<img src=x onerror=alert(1)>');
  });
  it.each([
    ['another chain', [token({ chain: 'evm:1' })]],
    ['uppercase address', [token({ address: USDC.toUpperCase().replace('0X', '0x') })]],
    ['short address', [token({ address: '0x1234' })]],
    ['a URL as address', [token({ address: 'https://evil.example' })]],
    ['negative decimals', [token({ decimals: -1 })]],
    ['fractional decimals', [token({ decimals: 6.5 })]],
    ['huge decimals', [token({ decimals: 255 })]],
    ['long symbol', [token({ symbol: 'A'.repeat(33) })]],
    ['control character', [token({ symbol: 'US\u0000DC' })]],
    ['zero-width character', [token({ symbol: 'US​DC' })]],
    ['line separator', [token({ name: 'a b' })]],
    ['padded text', [token({ name: ' USD Coin' })]],
    ['logoUri not a string', [token({ logoUri: 5 })]],
    ['tags not an array', [token({ tags: 'stablecoin' })]],
    ['duplicate address', [token(), token({ symbol: 'USDC2' })]],
    [
      'over 100 tokens',
      Array.from({ length: 101 }, (_, i) => token({ address: `0x${String(i).padStart(40, '0')}` })),
    ],
  ])('refuses %s', (_label, json) => {
    expect(() => parseTokens(json, 'evm:8453')).toThrow(SchemaError);
  });
});

describe('parseBalances', () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    chain: 'evm:8453',
    address: WALLET.toLowerCase(),
    blockNumber: '12345',
    balances: [
      { address: 'native', balance: '84100000000000000' },
      { address: USDC, balance: null },
    ],
    ...over,
  });
  it('reads base units as bigint and keeps null for a failed read', () => {
    const b = parseBalances(answer(), 'evm:8453', WALLET);
    expect(b.byAddress.get('native')).toBe(84100000000000000n);
    expect(b.byAddress.get(USDC)).toBeNull();
  });
  it('accepts the largest uint256 and nothing above it', () => {
    const max = (2n ** 256n - 1n).toString();
    expect(
      parseBalances(
        answer({ balances: [{ address: 'native', balance: max }] }),
        'evm:8453',
        WALLET,
      ).byAddress.get('native'),
    ).toBe(2n ** 256n - 1n);
    expect(() =>
      parseBalances(
        answer({ balances: [{ address: 'native', balance: (2n ** 256n).toString() }] }),
        'evm:8453',
        WALLET,
      ),
    ).toThrow(SchemaError);
  });
  it.each([
    ['another chain', answer({ chain: 'evm:1' })],
    ['another wallet', answer({ address: '0x1111111111111111111111111111111111112222' })],
    ['a float balance', answer({ balances: [{ address: 'native', balance: '1.5' }] })],
    ['a number balance', answer({ balances: [{ address: 'native', balance: 5 }] })],
    ['a leading zero', answer({ balances: [{ address: 'native', balance: '01' }] })],
    ['a negative balance', answer({ balances: [{ address: 'native', balance: '-1' }] })],
    ['a bad address', answer({ balances: [{ address: 'nope', balance: '1' }] })],
    [
      'a duplicate address',
      answer({
        balances: [
          { address: 'native', balance: '1' },
          { address: 'native', balance: '2' },
        ],
      }),
    ],
    ['a bad block number', answer({ blockNumber: 'latest' })],
    ['no balances', answer({ balances: undefined })],
  ])('refuses %s', (_label, json) => {
    expect(() => parseBalances(json, 'evm:8453', WALLET)).toThrow(SchemaError);
  });
});

/** A fetch that records its call and answers with `res`. */
function fakeFetch(res: () => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = ((url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(res());
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });
const never = new AbortController().signal;

describe('API client', () => {
  it('asks for tokens with a query string and no credentials, redirects or referrer', async () => {
    const { impl, calls } = fakeFetch(() => json([token()]));
    const tokens = await fetchTokens('evm:8453', 'usd', never, { origin: ORIGIN, fetch: impl });
    expect(tokens).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.toString()).toBe(`${ORIGIN}/v1/tokens?chain=evm%3A8453&q=usd&limit=100`);
    expect(call.init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    });
  });
  it('leaves q out when there is no search text', async () => {
    const { impl, calls } = fakeFetch(() => json([]));
    await fetchTokens('evm:1', '', never, { origin: ORIGIN, fetch: impl });
    expect(calls[0]!.url.searchParams.has('q')).toBe(false);
  });
  it('sends the wallet address in a POST body, never in the URL, and never from a cache', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ chain: 'evm:8453', address: WALLET.toLowerCase(), blockNumber: '1', balances: [] }),
    );
    await fetchBalances('evm:8453', WALLET, never, { origin: ORIGIN, fetch: impl });
    const call = calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(call.init.body as string)).toEqual({ chain: 'evm:8453', address: WALLET });
    expect(call.url.toString()).toBe(`${ORIGIN}/v1/balances`);
    expect(call.url.toString().toLowerCase()).not.toContain(WALLET.toLowerCase());
    expect(call.init.cache).toBe('no-store');
    expect(call.init.credentials).toBe('omit');
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
  it('has no API without an origin and makes no request', async () => {
    const { impl, calls } = fakeFetch(() => json([]));
    await expect(fetchChains(never, { origin: '', fetch: impl })).rejects.toMatchObject({
      kind: 'unconfigured',
    });
    expect(calls).toHaveLength(0);
  });
  it.each([
    ['500', () => json({}, { status: 500 }), 'http'],
    ['404', () => json({}, { status: 404 }), 'http'],
    ['a redirect-looking 302', () => json({}, { status: 302 }), 'http'],
    [
      'text/html',
      () => new Response('[]', { headers: { 'content-type': 'text/html' } }),
      'content',
    ],
    ['no content type', () => new Response('[]'), 'content'],
    [
      'broken JSON',
      () => new Response('[', { headers: { 'content-type': 'application/json' } }),
      'content',
    ],
    [
      'invalid UTF-8',
      () =>
        new Response(new Uint8Array([0x5b, 0xff, 0x5d]), {
          headers: { 'content-type': 'application/json' },
        }),
      'content',
    ],
    ['a wrong shape', () => json({ not: 'a list' }), 'invalid'],
    [
      'a huge body',
      () =>
        new Response(`["${'a'.repeat(MAX_RESPONSE_CHARS)}"]`, {
          headers: { 'content-type': 'application/json' },
        }),
      'content',
    ],
  ])('refuses %s', async (_label, res, kind) => {
    const { impl } = fakeFetch(res);
    const err = await fetchChains(never, { origin: ORIGIN, fetch: impl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe(kind);
  });
  it('turns a network failure into a fixed-text error', async () => {
    const impl = (() =>
      Promise.reject(
        new TypeError('Failed to fetch https://secret.example/?k=1'),
      )) as unknown as typeof fetch;
    const err = await fetchChains(never, { origin: ORIGIN, fetch: impl }).catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe('network');
    expect((err as ApiError).message).not.toContain('secret');
  });
  it('gives a caller that aborts an AbortError, not an API error', async () => {
    const controller = new AbortController();
    const impl = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const pending = fetchChains(controller.signal, { origin: ORIGIN, fetch: impl });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(isAbort(err)).toBe(true);
    expect(err).not.toBeInstanceOf(ApiError);
  });
  it('times out a request that never answers', async () => {
    const impl = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const err = await fetchChains(never, { origin: ORIGIN, fetch: impl, timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).kind).toBe('timeout');
  });
});

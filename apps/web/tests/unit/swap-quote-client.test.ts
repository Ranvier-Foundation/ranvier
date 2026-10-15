import { describe, expect, it } from 'vitest';
import { ApiError, MAX_RESPONSE_CHARS, fetchQuote, isAbort } from '../../src/lib/api/client';
import { ASK, SECRETS, TAKER, swapAnswer, wrapAnswer, WRAP_ASK } from './helpers/quote-fixtures';

const ORIGIN = 'https://api.example';
const never = new AbortController().signal;

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
const ask = (impl: typeof fetch) => fetchQuote(ASK, never, { origin: ORIGIN, fetch: impl });

describe('fetchQuote: what is sent', () => {
  it('POSTs the tokens as { chain, address }, the amount as a string, the taker and the slippage, and nothing else', async () => {
    const { impl, calls } = fakeFetch(() => json(swapAnswer()));
    await ask(impl);
    const call = calls[0]!;
    expect(call.url.toString()).toBe(`${ORIGIN}/v1/quotes`);
    expect(call.init.method).toBe('POST');
    expect(JSON.parse(call.init.body as string)).toEqual({
      sellToken: { chain: 'evm:1', address: 'native' },
      buyToken: { chain: 'evm:1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      sellAmount: '50000000000000000',
      taker: TAKER,
      slippageBps: 50,
    });
    // The body is JSON text of exactly these keys: no symbol, no decimals (the API refuses them).
    expect(Object.keys(JSON.parse(call.init.body as string)).sort()).toEqual([
      'buyToken',
      'sellAmount',
      'sellToken',
      'slippageBps',
      'taker',
    ]);
  });

  it('keeps the wallet address out of the URL, sends no credentials, no referrer, no redirect, and never caches', async () => {
    const { impl, calls } = fakeFetch(() => json(swapAnswer()));
    await ask(impl);
    const call = calls[0]!;
    expect(call.url.toString().toLowerCase()).not.toContain(TAKER.toLowerCase().slice(2));
    expect(call.url.search).toBe('');
    expect(call.init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
      cache: 'no-store',
    });
    expect(call.init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  it('makes no request without an API origin', async () => {
    const { impl, calls } = fakeFetch(() => json(swapAnswer()));
    await expect(
      fetchQuote(ASK, never, { origin: '', fetch: impl }),
    ).rejects.toMatchObject({ kind: 'unconfigured' });
    expect(calls).toHaveLength(0);
  });
});

describe('fetchQuote: what comes back', () => {
  it('returns the display fields of a routed swap and of a wrap', async () => {
    const q = await ask(fakeFetch(() => json(swapAnswer())).impl);
    expect(q).toMatchObject({ kind: 'swap', buyAmount: 124_750_000n });
    const w = await fetchQuote(WRAP_ASK, never, {
      origin: ORIGIN,
      fetch: fakeFetch(() => json(wrapAnswer())).impl,
    });
    expect(w).toMatchObject({ kind: 'wrap', direction: 'wrap' });
  });

  it('never keeps the calldata, signature or signed transaction of the answer', async () => {
    const q = await ask(fakeFetch(() => json(swapAnswer())).impl);
    const kept = JSON.stringify(q, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    for (const secret of SECRETS) expect(kept).not.toContain(secret);
  });

  it('refuses an answer for another request, whole', async () => {
    const other = swapAnswer({ quote: { user: '0x1111111111111111111111111111111111112222' } });
    const err = await ask(fakeFetch(() => json(other)).impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe('invalid');
    // The error says what kind of failure it was and nothing of the answer.
    expect((err as ApiError).message).toBe('API request failed: invalid');
  });

  it.each([
    ['text/html', () => new Response('{}', { headers: { 'content-type': 'text/html' } }), 'content'],
    ['no content type', () => new Response('{}'), 'content'],
    [
      'broken JSON',
      () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      'content',
    ],
    [
      'a huge body',
      () =>
        new Response(`{"x":"${'a'.repeat(MAX_RESPONSE_CHARS)}"}`, {
          headers: { 'content-type': 'application/json' },
        }),
      'content',
    ],
    ['a redirect-looking 302', () => json({}, { status: 302 }), 'http'],
    ['201', () => json(swapAnswer(), { status: 201 }), 'http'],
  ])('refuses %s', async (_label, res, kind) => {
    const err = await ask(fakeFetch(res).impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe(kind);
  });
});

describe('fetchQuote: error answers carry a stable code and nothing else', () => {
  const failure = (status: number, body: unknown) => () => json(body, { status });
  const code = async (res: () => Response) =>
    ((await ask(fakeFetch(res).impl).catch((e: unknown) => e)) as ApiError).code;

  it.each([
    [502, { error: 'no_route', failures: [{ provider: '0x', error: 'no_liquidity' }] }, 'no_route'],
    [
      502,
      { error: 'no_route', failures: [{ provider: '0x', error: 'timeout' }] },
      'routing_slow',
    ],
    [503, { error: 'price_unavailable' }, 'price_unavailable'],
    [503, { error: 'routing_unavailable', message: 'No routing providers are configured' }, 'routing_unavailable'],
    [503, { error: 'signing_unavailable' }, 'signing_unavailable'],
    [500, { error: 'internal_error' }, 'internal_error'],
    [400, { error: 'invalid_request', fields: ['sellToken.address'] }, 'invalid_request'],
  ])('%i %j is %s', async (status, body, expected) => {
    expect(await code(failure(status, body))).toBe(expected);
  });

  it('keeps no text from the answer in the error', async () => {
    const err = (await ask(
      fakeFetch(failure(503, { error: 'routing_unavailable', message: 'SECRET <script>' })).impl,
    ).catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe('API request failed: http 503 routing_unavailable');
    expect(JSON.stringify(err)).not.toContain('SECRET');
  });

  it.each([
    ['an unknown code', failure(503, { error: 'teapot' })],
    ['a body that is not JSON', () => new Response('<html>', { status: 502, headers: { 'content-type': 'text/html' } })],
    ['broken JSON', () => new Response('{', { status: 502, headers: { 'content-type': 'application/json' } })],
    [
      'a huge body',
      () =>
        new Response(`{"error":"${'a'.repeat(100_000)}"}`, {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    ],
  ])('has no code for %s, but is still an http error', async (_n, res) => {
    const err = (await ask(fakeFetch(res).impl).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('http');
    expect(err.code).toBeUndefined();
  });
});

describe('fetchQuote: aborting and time', () => {
  it('gives a caller that aborts an AbortError, not an API error', async () => {
    const controller = new AbortController();
    const impl = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const pending = fetchQuote(ASK, controller.signal, { origin: ORIGIN, fetch: impl });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(isAbort(err)).toBe(true);
  });

  it('a caller that aborts while an error answer is read still gets the AbortError', async () => {
    const controller = new AbortController();
    const impl = (() => {
      controller.abort();
      return Promise.resolve(json({ error: 'no_route' }, { status: 502 }));
    }) as unknown as typeof fetch;
    const err = await fetchQuote(ASK, controller.signal, { origin: ORIGIN, fetch: impl }).catch(
      (e: unknown) => e,
    );
    expect(isAbort(err)).toBe(true);
  });

  it('times out a request that never answers', async () => {
    const impl = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const err = await fetchQuote(ASK, never, { origin: ORIGIN, fetch: impl, timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).kind).toBe('timeout');
  });

  it('a network failure is a fixed-text error', async () => {
    const impl = (() =>
      Promise.reject(new TypeError(`Failed to fetch https://secret.example/?k=${TAKER}`))) as unknown as typeof fetch;
    const err = (await ask(impl).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain('secret');
    expect(err.message).not.toContain(TAKER);
  });
});

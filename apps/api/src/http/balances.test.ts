import { listTokens } from '@ranvier/chains';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViemChainReader } from '../adapters/rpc/viem-chain-reader.js';
import { BalanceService, type BalanceServiceOptions } from '../domain/balances.js';
import {
  ChainReadError,
  type BalancesRead,
  type BalancesRequest,
  type ChainReader,
} from '../ports/chain-reader.js';
import { FakeRpc, node } from '../testing/fake-rpc.js';
import { BALANCES_BODY_LIMIT, BALANCES_CACHE_CONTROL, type BalancesView } from './balances.js';
import type { ChainView } from './lists.js';
import { buildServer, requestLogSerializer, type ServerDeps } from './server.js';

const OWNER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const MIXED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const KEY = 'SECRETKEY123';
const ORIGIN = 'https://app.example';
const JSON_TYPE = { 'content-type': 'application/json' };

class StubReader implements ChainReader {
  readable = true;
  calls: BalancesRequest[] = [];
  signals: AbortSignal[] = [];
  impl: (req: BalancesRequest, signal: AbortSignal) => Promise<BalancesRead> = async (req) => ({
    blockNumber: 123n,
    native: 10n ** 18n,
    tokens: req.tokens.map((_t, i) => (i === 0 ? null : BigInt(i) * 2n ** 200n)),
  });
  canRead(): boolean {
    return this.readable;
  }
  readBalances(req: BalancesRequest, signal: AbortSignal): Promise<BalancesRead> {
    this.calls.push(req);
    this.signals.push(signal);
    return this.impl(req, signal);
  }
}

/** A read that never answers on its own, only rejects when its signal aborts. */
const hang = (_req: BalancesRequest, signal: AbortSignal): Promise<BalancesRead> =>
  new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new ChainReadError('timeout', 'deadline'))),
  );

function server(
  reader: ChainReader = new StubReader(),
  deps: Partial<ServerDeps> = {},
  svc: Partial<BalanceServiceOptions> = {},
) {
  const service = new BalanceService({ reader, servedChainIds: [1, 8453, 42161], ...svc });
  return buildServer({
    providers: [],
    servedChainIds: [1, 8453, 42161],
    balances: { service, deadlineMs: 200 },
    ...deps,
  });
}

type App = ReturnType<typeof server>;

const post = (app: App, body: unknown, headers: Record<string, string> = JSON_TYPE) =>
  app.inject({
    method: 'POST',
    url: '/v1/balances',
    headers,
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

const ok = { chain: 'evm:1', address: OWNER };

const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('POST /v1/balances', () => {
  it('returns every listed token of the chain at one block, as decimal strings', async () => {
    const reader = new StubReader();
    const res = await post(server(reader), ok);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
    expect(BALANCES_CACHE_CONTROL).toBe('private, no-store');
    const body = res.json<BalancesView>();
    const list = listTokens('evm:1');
    expect(body.chain).toBe('evm:1');
    expect(body.address).toBe(OWNER);
    expect(body.blockNumber).toBe('123');
    expect(body.balances.map((b) => b.address)).toEqual(list.map((t) => t.address));
    expect(body.balances[0]).toEqual({ address: 'native', balance: '1000000000000000000' });
    expect(body.balances[1]?.balance).toBeNull();
    expect(body.balances[2]?.balance).toBe((2n ** 200n).toString());
    expect(Object.keys(body).sort()).toEqual(['address', 'balances', 'blockNumber', 'chain']);
    expect(reader.calls).toHaveLength(1);
  });

  it('accepts any letter case and a charset, normalises, never echoes the raw input', async () => {
    const res = await post(
      server(),
      { chain: 'evm:8453', address: MIXED },
      { 'content-type': 'application/json; charset=utf-8' },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<BalancesView>().address).toBe(OWNER);
    expect(res.body).not.toContain(MIXED);
  });

  it('answers GET and HEAD with 405 Allow: POST, and never reads', async () => {
    const reader = new StubReader();
    const app = server(reader);
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await app.inject({ method, url: `/v1/balances?chain=evm:1&address=${OWNER}` });
      expect(res.statusCode, method).toBe(405);
      expect(res.headers.allow).toBe('POST');
      expect(res.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
    }
    const get = await app.inject({ method: 'GET', url: '/v1/balances' });
    expect(get.json()).toEqual({ error: 'method_not_allowed' });
    expect(reader.calls).toHaveLength(0);
  });

  it.each([
    [{}, ['chain', 'address']],
    [{ chain: 'evm:1' }, ['address']],
    [{ address: OWNER }, ['chain']],
    [{ ...ok, x: 1 }, ['(body)']],
    // The RPC URL comes from the environment only; a request cannot name one.
    [{ ...ok, rpc: 'https://evil.example' }, ['(body)']],
    [[ok], ['(body)']],
    ['"evm:1"', ['(body)']],
    ['null', ['(body)']],
    [{ chain: 1, address: OWNER }, ['chain']],
    [{ chain: 'evm:1', address: 1 }, ['address']],
    [{ chain: 'solana:mainnet', address: OWNER }, ['chain']],
    [{ chain: 'evm:10', address: OWNER }, ['chain']],
    [{ chain: 'evm:01', address: OWNER }, ['chain']],
    [{ chain: 'evm:84532', address: OWNER }, ['chain']],
    [{ chain: 'evm:1', address: OWNER.slice(0, 41) }, ['address']],
    [{ chain: 'evm:1', address: `${OWNER}00` }, ['address']],
    [{ chain: 'evm:1', address: `0x${'g'.repeat(40)}` }, ['address']],
    [{ chain: 'evm:1', address: OWNER.slice(2) }, ['address']],
    [{ chain: 'evm:1', address: 'native' }, ['address']],
    [{ chain: 'evm:1', address: `0x${'0'.repeat(40)}` }, ['address']],
    [{ chain: 'evm:1', address: `0x${'E'.repeat(40)}` }, ['address']],
  ])('refuses %j with 400 and field paths only', async (body, fields) => {
    const reader = new StubReader();
    const res = await post(server(reader), body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request', fields });
    expect(res.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
    expect(reader.calls).toHaveLength(0);
  });

  it('refuses a body that is not JSON (415), malformed JSON (400) or too large (413)', async () => {
    const reader = new StubReader();
    const app = server(reader);
    const cases: [string, Record<string, string>, number, string][] = [
      [JSON.stringify(ok), { 'content-type': 'text/plain' }, 415, 'invalid_request'],
      [
        `chain=evm:1&address=${OWNER}`,
        { 'content-type': 'application/x-www-form-urlencoded' },
        415,
        'invalid_request',
      ],
      [JSON.stringify(ok), {}, 415, 'invalid_request'],
      [`{"chain":"evm:1","address":"${OWNER}"`, JSON_TYPE, 400, 'invalid_request'],
      [
        JSON.stringify({ ...ok, pad: 'x'.repeat(BALANCES_BODY_LIMIT) }),
        JSON_TYPE,
        413,
        'payload_too_large',
      ],
    ];
    for (const [payload, headers, status, error] of cases) {
      const res = await app.inject({ method: 'POST', url: '/v1/balances', headers, payload });
      expect(res.statusCode, payload.slice(0, 30)).toBe(status);
      expect(res.json()).toEqual({ error });
      expect(res.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
      expect(res.body).not.toContain(OWNER);
    }
    expect(reader.calls).toHaveLength(0);
  });

  it('answers 503 rpc_unavailable when no RPC is healthy, 400 when balances are not set up', async () => {
    const bare = buildServer({ providers: [], servedChainIds: [1] });
    expect((await post(bare, ok)).statusCode).toBe(400);
    const reader = new StubReader();
    reader.readable = false;
    const res = await post(server(reader), ok);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rpc_unavailable' });
    expect(reader.calls).toHaveLength(0);
  });

  it('maps reader failures to stable codes: 503 rpc_unavailable and 504 timeout', async () => {
    const reader = new StubReader();
    reader.impl = async () => {
      throw new ChainReadError('rpc_unavailable', 'rpc_error');
    };
    const unavailable = await post(server(reader), ok);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: 'rpc_unavailable' });

    reader.impl = hang;
    const started = Date.now();
    const timeout = await post(server(reader), ok);
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json()).toEqual({ error: 'timeout' });
    expect(timeout.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('answers an unexpected error with 500 internal_error', async () => {
    const reader = new StubReader();
    reader.impl = async () => {
      throw new TypeError(`bug near https://rpc.example/${KEY}`);
    };
    const res = await post(server(reader), ok);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
  });
});

describe('POST /v1/balances: CORS', () => {
  it('grants the allowed origin, preflight included, and Vary: Origin on every answer', async () => {
    const app = server(undefined, { webOrigins: [ORIGIN] });
    const res = await post(app, ok, { ...JSON_TYPE, origin: ORIGIN });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers.vary).toBe('Origin');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/balances',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type');
    for (const res of [
      await post(app, { chain: 'evm:1' }, { ...JSON_TYPE, origin: ORIGIN }),
      await post(app, '{', { ...JSON_TYPE, origin: ORIGIN }),
      await post(app, ok, { 'content-type': 'text/plain', origin: ORIGIN }),
      await app.inject({ method: 'GET', url: '/v1/balances', headers: { origin: ORIGIN } }),
    ]) {
      expect(res.headers.vary).toBe('Origin');
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(res.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
    }
  });

  it('refuses the grant and the preflight to any other origin', async () => {
    const app = server(undefined, { webOrigins: [ORIGIN] });
    const evil = 'https://evil.example';
    const res = await post(app, ok, { ...JSON_TYPE, origin: evil });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/balances',
      headers: { origin: evil, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
  });
});

describe('framework errors', () => {
  it('answers a malformed URL with the stable code, uncacheable, without echoing it', async () => {
    const app = server(undefined, { webOrigins: [ORIGIN] });
    for (const url of [`/v1/balances%zz?address=${OWNER}`, '/v1/%E0%A4%A']) {
      const res = await app.inject({ method: 'POST', url, headers: { origin: ORIGIN } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.vary).toBe('Origin');
      expect(res.body).not.toMatch(/%|balances|0x/);
    }
  });
});

describe('client disconnect', () => {
  it('abandons the read promptly and frees the limiter slot', async () => {
    const reader = new StubReader();
    reader.impl = hang;
    const service = new BalanceService({
      reader,
      servedChainIds: [1],
      maxInFlightPerChain: 1,
      maxQueuePerChain: 0,
    });
    const app = buildServer({
      providers: [],
      servedChainIds: [1],
      balances: { service, deadlineMs: 10_000 },
    });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const body = JSON.stringify(ok);
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(
      `POST /v1/balances HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\n` +
        `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await vi.waitFor(() => expect(reader.signals).toHaveLength(1));
    const closedAt = Date.now() + 300;
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.destroy();
    await vi.waitFor(() => expect(reader.signals[0]?.aborted).toBe(true), { timeout: 2_000 });
    expect(Date.now() - closedAt).toBeLessThan(1_000);
    // The slot is free again: a new read (another wallet) is not refused as busy.
    reader.impl = async (req) => ({
      blockNumber: 1n,
      native: 0n,
      tokens: req.tokens.map(() => 0n),
    });
    const next = await app.inject({
      method: 'POST',
      url: '/v1/balances',
      headers: JSON_TYPE,
      payload: JSON.stringify({ chain: 'evm:1', address: `0x${'1'.repeat(40)}` }),
    });
    expect(next.statusCode, next.body).toBe(200);
  });
});

describe('GET /v1/chains balances flag', () => {
  it('is true only for chains the reader can read right now', async () => {
    const reader = new StubReader();
    const app = server(reader);
    const flags = async () =>
      (await app.inject({ method: 'GET', url: '/v1/chains' }))
        .json<ChainView[]>()
        .map((c) => [c.key, c.balances]);
    expect(await flags()).toEqual([
      ['evm:1', true],
      ['evm:8453', true],
      ['evm:42161', true],
    ]);
    reader.readable = false;
    expect(await flags()).toEqual([
      ['evm:1', false],
      ['evm:8453', false],
      ['evm:42161', false],
    ]);
  });
});

describe('wallet addresses never reach the logs', () => {
  function logged(reader: ChainReader = new StubReader()) {
    const lines: string[] = [];
    const service = new BalanceService({ reader, servedChainIds: [1] });
    const app = buildServer({
      providers: [],
      servedChainIds: [1],
      balances: { service, deadlineMs: 200 },
      logger: { stream: { write: (line: string) => lines.push(line) }, level: 'debug' },
    });
    return { app, lines };
  }

  it('holds for success, invalid, malformed, oversized, failed and unexpected requests', async () => {
    const reader = new StubReader();
    const { app, lines } = logged(reader);
    await post(app, { chain: 'evm:1', address: MIXED });
    await post(app, { chain: 'evm:1', address: MIXED, extra: OWNER });
    // A JSON parse error message quotes the body: it must not be logged.
    await post(app, `{"chain":"evm:1","address":"${OWNER}",}`);
    await post(app, { chain: 'evm:1', address: OWNER, pad: `${OWNER}`.repeat(40) });
    await post(app, { chain: 'evm:1', address: OWNER }, { 'content-type': 'text/plain' });
    await app.inject({ method: 'GET', url: `/v1/balances?chain=evm:1&address=${OWNER}` });
    await app.inject({ method: 'GET', url: `/v1/balances%zz?address=${OWNER}` });
    reader.impl = async () => {
      throw new ChainReadError('rpc_unavailable', 'rpc_error');
    };
    await post(app, { chain: 'evm:1', address: `0x${'1'.repeat(40)}` });
    reader.impl = async () => {
      throw new TypeError('bug');
    };
    await post(app, { chain: 'evm:1', address: `0x${'2'.repeat(40)}` });
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThanOrEqual(18);
    expect(text.toLowerCase()).not.toContain(OWNER.slice(2));
    expect(text).not.toMatch(/1{40}|2{40}|address=|\?/);
    const incoming = lines.map((l) => JSON.parse(l) as { msg: string; req?: { url: string } });
    const urls = incoming.filter((l) => l.msg === 'incoming request').map((l) => l.req?.url);
    expect(urls.filter((u) => u === '/v1/balances')).toHaveLength(8);
    expect(text).toContain('balances unavailable');
    expect(text).toContain('rejected request');
  });

  it('serializes requests without the query string', () => {
    const req = { method: 'GET', url: `/v1/balances?address=${OWNER}`, hostname: 'h', ip: '::1' };
    expect(requestLogSerializer(req as never)).toEqual({
      method: 'GET',
      url: '/v1/balances',
      hostname: 'h',
      remoteAddress: '::1',
    });
    expect(requestLogSerializer({ ...req, url: '/health' } as never).url).toBe('/health');
  });
});

describe('RPC credentials never reach a response or a log line', () => {
  it('holds for every failure mode, end to end through the viem reader', async () => {
    const A = `https://rpc-a.example/v2/${KEY}`;
    const B = `https://u:${KEY}@rpc-b.example/?key=${KEY}`;
    const rpc = new FakeRpc();
    rpc.nodes.set(A, node());
    rpc.nodes.set(B, node());
    const lines: string[] = [];
    const sink = {
      info: (o: object, m: string) => lines.push(JSON.stringify({ o, m })),
      warn: (o: object, m: string) => lines.push(JSON.stringify({ o, m })),
      error: (o: object, m: string) => lines.push(JSON.stringify({ o, m })),
    };
    const reader = new ViemChainReader({
      endpoints: new Map([
        [
          1,
          [
            { url: A, label: 'RPC_URLS_EVM_1[0]' },
            { url: B, label: 'RPC_URLS_EVM_1[1]' },
          ],
        ],
      ]),
      fetch: rpc.fetch,
      log: sink,
      requestTimeoutMs: 30,
      retryCount: 0,
      now: () => Number(node().timestamp) * 1000,
    });
    await reader.verifyEndpoints();
    const service = new BalanceService({
      reader,
      servedChainIds: [1],
      cacheTtlMs: 0,
      failureTtlMs: 0,
    });
    const app = buildServer({
      providers: [],
      servedChainIds: [1],
      balances: { service, deadlineMs: 500 },
      logger: { stream: { write: (line: string) => lines.push(line) }, level: 'debug' },
    });
    const bodies: string[] = [];
    const modes = ['ok', 'down', 'http500', 'http429', 'hang', 'revert-call', 'redirect'] as const;
    for (const mode of modes) {
      rpc.nodes.get(A)!.mode = mode;
      rpc.nodes.get(B)!.mode = mode;
      const res = await post(app, ok);
      bodies.push(`${res.statusCode} ${res.body} ${JSON.stringify(res.headers)}`);
    }
    for (const junk of [
      { eth_blockNumber: `https://rpc-a.example/${KEY}` },
      { eth_call: '0x12' },
    ]) {
      rpc.nodes.get(A)!.mode = 'ok';
      rpc.nodes.get(A)!.results = junk;
      rpc.nodes.get(B)!.mode = 'down';
      const res = await post(app, ok);
      bodies.push(`${res.statusCode} ${res.body}`);
    }
    expect(bodies.map((b) => b.slice(0, 3))).toEqual([
      '200',
      '503',
      '503',
      '503',
      '504',
      '503',
      '503',
      '503',
      '503',
    ]);
    const everything = [...bodies, ...lines].join('\n');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toMatch(/rpc-a\.example|rpc-b\.example/);
    expect(lines.join('\n').toLowerCase()).not.toContain(OWNER.slice(2));
    // Credentials from the URL's user info reach the provider as a header, not in the URL.
    expect(rpc.authorization.some((h) => h?.startsWith('Basic '))).toBe(true);
  });
});

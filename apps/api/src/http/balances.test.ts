import { listTokens } from '@ranvier/chains';
import { describe, expect, it } from 'vitest';
import { ViemChainReader } from '../adapters/rpc/viem-chain-reader.js';
import { BalanceService } from '../domain/balances.js';
import {
  ChainReadError,
  type BalancesRead,
  type BalancesRequest,
  type ChainReader,
} from '../ports/chain-reader.js';
import { FakeRpc, node } from '../testing/fake-rpc.js';
import { BALANCES_CACHE_CONTROL, type BalancesView } from './balances.js';
import type { ChainView } from './lists.js';
import { buildServer, requestLogSerializer, type ServerDeps } from './server.js';

const OWNER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const MIXED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const KEY = 'SECRETKEY123';
const ORIGIN = 'https://app.example';

class StubReader implements ChainReader {
  readable = true;
  calls: BalancesRequest[] = [];
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
    return this.impl(req, signal);
  }
}

function server(reader: ChainReader = new StubReader(), deps: Partial<ServerDeps> = {}) {
  const service = new BalanceService({ reader, servedChainIds: [1, 8453, 42161] });
  return buildServer({
    providers: [],
    servedChainIds: [1, 8453, 42161],
    balances: { service, deadlineMs: 200 },
    ...deps,
  });
}

const get = (app: ReturnType<typeof server>, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

describe('GET /v1/balances', () => {
  it('returns every listed token of the chain at one block, as decimal strings', async () => {
    const reader = new StubReader();
    const res = await get(server(reader), `/v1/balances?chain=evm:1&address=${OWNER}`);
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

  it('accepts any letter case, normalises to lowercase and never echoes the raw input', async () => {
    const res = await get(server(), `/v1/balances?chain=evm:8453&address=${MIXED}`);
    expect(res.statusCode).toBe(200);
    expect(res.json<BalancesView>().address).toBe(OWNER);
    expect(res.body).not.toContain(MIXED);
  });

  it('carries the CORS grant and Vary: Origin', async () => {
    const app = server(undefined, { webOrigins: [ORIGIN] });
    const res = await get(app, `/v1/balances?chain=evm:1&address=${OWNER}`, { origin: ORIGIN });
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers.vary).toBe('Origin');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    const other = await get(app, `/v1/balances?chain=evm:1&address=${OWNER}`, {
      origin: 'https://evil.example',
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/balances',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it.each([
    ['', ['chain', 'address']],
    [`?chain=evm:1`, ['address']],
    [`?address=${OWNER}`, ['chain']],
    [`?chain=evm:1&address=${OWNER}&x=1`, ['(body)']],
    // The RPC URL comes from the environment only; a request cannot name one.
    [`?chain=evm:1&address=${OWNER}&rpc=https://evil.example`, ['(body)']],
    [`?chain=evm:1&chain=evm:1&address=${OWNER}`, ['chain']],
    [`?chain=evm:1&address=${OWNER}&address=${OWNER}`, ['address']],
    [`?chain=solana:mainnet&address=${OWNER}`, ['chain']],
    [`?chain=evm:10&address=${OWNER}`, ['chain']],
    [`?chain=evm:01&address=${OWNER}`, ['chain']],
    [`?chain=evm:84532&address=${OWNER}`, ['chain']],
    [`?chain=evm:1&address=${OWNER.slice(0, 41)}`, ['address']],
    [`?chain=evm:1&address=${OWNER}00`, ['address']],
    [`?chain=evm:1&address=0x${'g'.repeat(40)}`, ['address']],
    [`?chain=evm:1&address=${OWNER.slice(2)}`, ['address']],
    [`?chain=evm:1&address=native`, ['address']],
    [`?chain=evm:1&address=0x${'0'.repeat(40)}`, ['address']],
    [`?chain=evm:1&address=0x${'E'.repeat(40)}`, ['address']],
  ])('refuses %s with 400 and field paths only', async (query, fields) => {
    const reader = new StubReader();
    const res = await get(server(reader), `/v1/balances${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request', fields });
    expect(res.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
    expect(reader.calls).toHaveLength(0);
  });

  it('answers 503 rpc_unavailable when balances are not configured or no RPC is healthy', async () => {
    const bare = buildServer({ providers: [], servedChainIds: [1] });
    const none = await get(bare, `/v1/balances?chain=evm:1&address=${OWNER}`);
    // Without a service no chain is served for balances: the chain is invalid.
    expect(none.statusCode).toBe(400);
    const reader = new StubReader();
    reader.readable = false;
    const res = await get(server(reader), `/v1/balances?chain=evm:1&address=${OWNER}`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rpc_unavailable' });
    expect(res.headers['cache-control']).toBe(BALANCES_CACHE_CONTROL);
    expect(reader.calls).toHaveLength(0);
  });

  it('maps reader failures to stable codes: 503 rpc_unavailable and 504 timeout', async () => {
    const reader = new StubReader();
    reader.impl = async () => {
      throw new ChainReadError('rpc_unavailable', 'rpc_error');
    };
    const unavailable = await get(server(reader), `/v1/balances?chain=evm:1&address=${OWNER}`);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ error: 'rpc_unavailable' });

    reader.impl = (_req, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new ChainReadError('timeout', 'deadline'))),
      );
    const started = Date.now();
    const timeout = await get(server(reader), `/v1/balances?chain=evm:1&address=${OWNER}`);
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
    const res = await get(server(reader), `/v1/balances?chain=evm:1&address=${OWNER}`);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
  });
});

describe('GET /v1/chains balances flag', () => {
  it('is true only for chains the reader can read right now', async () => {
    const reader = new StubReader();
    const app = server(reader);
    const flags = async () =>
      (await get(app, '/v1/chains')).json<ChainView[]>().map((c) => [c.key, c.balances]);
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
      logger: { stream: { write: (line: string) => lines.push(line) }, level: 'info' },
    });
    return { app, lines };
  }

  it('logs the path only, for success, invalid and failed requests', async () => {
    const reader = new StubReader();
    const { app, lines } = logged(reader);
    await get(app, `/v1/balances?chain=evm:1&address=${MIXED}`);
    await get(app, `/v1/balances?chain=evm:1&address=${MIXED}&extra=${OWNER}`);
    reader.impl = async () => {
      throw new ChainReadError('rpc_unavailable', 'rpc_error');
    };
    await get(app, `/v1/balances?chain=evm:1&address=0x${'1'.repeat(40)}`);
    reader.impl = async () => {
      throw new TypeError('bug');
    };
    await get(app, `/v1/balances?chain=evm:1&address=0x${'2'.repeat(40)}`);
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(text.toLowerCase()).not.toContain(OWNER.slice(2));
    expect(text).not.toMatch(/1{40}|2{40}|address=|\?/);
    const incoming = lines.map((l) => JSON.parse(l) as { msg: string; req?: { url: string } });
    const urls = incoming.filter((l) => l.msg === 'incoming request').map((l) => l.req?.url);
    expect(urls).toEqual(['/v1/balances', '/v1/balances', '/v1/balances', '/v1/balances']);
    expect(text).toContain('balances unavailable');
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
    const modes = ['ok', 'down', 'http500', 'http429', 'hang', 'revert-call'] as const;
    for (const mode of modes) {
      rpc.nodes.get(A)!.mode = mode;
      rpc.nodes.get(B)!.mode = mode;
      const res = await get(app, `/v1/balances?chain=evm:1&address=${OWNER}`);
      bodies.push(`${res.statusCode} ${res.body} ${JSON.stringify(res.headers)}`);
    }
    for (const junk of [
      { eth_blockNumber: `https://rpc-a.example/${KEY}` },
      { eth_call: '0x12' },
    ]) {
      rpc.nodes.get(A)!.mode = 'ok';
      rpc.nodes.get(A)!.results = junk;
      rpc.nodes.get(B)!.mode = 'down';
      const res = await get(app, `/v1/balances?chain=evm:1&address=${OWNER}`);
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
    ]);
    const everything = [...bodies, ...lines].join('\n');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toMatch(/rpc-a\.example|rpc-b\.example/);
    expect(lines.join('\n').toLowerCase()).not.toContain(OWNER.slice(2));
    // Credentials from the URL's user info reach the provider as a header, not in the URL.
    expect(rpc.authorization.some((h) => h?.startsWith('Basic '))).toBe(true);
  });
});

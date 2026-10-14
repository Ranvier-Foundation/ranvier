import { HttpRequestError, RpcRequestError, toHex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChainReadError } from '../../ports/chain-reader.js';
import { FakeRpc, MC, node, type FakeNode, type TokenAnswer } from '../../testing/fake-rpc.js';
import {
  describeError,
  MULTICALL3,
  MULTICALL3_CHAINS,
  ViemChainReader,
  type ReaderLog,
  type ViemChainReaderOptions,
} from './viem-chain-reader.js';

// URLs carry fake keys: no log line or error may ever contain them.
const KEY = 'SECRETKEY123';
const A = `https://rpc-a.example/v2/${KEY}`;
const B = `https://user:${KEY}@rpc-b.example/path?apikey=${KEY}`;
const OWNER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
const T0 = 1_700_000_000n;

interface Line {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}

function setup(
  nodes: Record<string, Partial<FakeNode>>,
  opts: Partial<ViemChainReaderOptions> = {},
  chainId = 1,
) {
  const rpc = new FakeRpc();
  for (const [url, n] of Object.entries(nodes)) rpc.nodes.set(url, node({ chainId, ...n }));
  const lines: Line[] = [];
  const log: ReaderLog = {
    info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => lines.push({ level: 'error', obj, msg }),
  };
  let clock = Number(T0) * 1000 + 5_000;
  const reader = new ViemChainReader({
    endpoints: new Map([
      [chainId, Object.keys(nodes).map((url, i) => ({ url, label: `E[${i}]` }))],
    ]),
    fetch: rpc.fetch,
    log,
    now: () => clock,
    requestTimeoutMs: 200,
    retryCount: 0,
    retryDelayMs: 1,
    ...opts,
  });
  return {
    rpc,
    reader,
    lines,
    tick: (ms: number) => (clock += ms),
    read: (tokens: readonly `0x${string}`[] = [USDC, DAI], signal = AbortSignal.timeout(2_000)) =>
      reader.readBalances({ chainId, owner: OWNER, tokens }, signal),
  };
}

/** Everything a reader produced that could leak: log lines and error text. */
function expectNoSecrets(lines: Line[], extra: unknown[] = []): void {
  const text =
    JSON.stringify(lines) +
    extra.map((e) => (e instanceof Error ? `${e.name} ${e.message}` : String(e))).join(' ');
  expect(text).not.toContain(KEY);
  expect(text).not.toMatch(/rpc-a\.example|rpc-b\.example|https?:/);
  expect(text.toLowerCase()).not.toContain(OWNER.slice(2));
}

async function failure(p: Promise<unknown>): Promise<ChainReadError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChainReadError);
  return err as ChainReadError;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Multicall3 support', () => {
  it('uses the canonical address, found in viem for Ethereum, Base and Arbitrum One', () => {
    expect(MULTICALL3).toBe(MC);
    expect([...MULTICALL3_CHAINS].sort((a, b) => a - b)).toEqual([1, 8453, 42161]);
  });
});

describe('endpoint verification (eth_chainId)', () => {
  it('serves nothing before an endpoint proves its chain', async () => {
    const { reader, rpc, read } = setup({ [A]: {} });
    expect(reader.canRead(1)).toBe(false);
    const err = await failure(read());
    expect(err.code).toBe('rpc_unavailable');
    expect(err.reason).toBe('no_verified_endpoint');
    // The refused read started a verification in the background; no balance call was made.
    await vi.waitFor(() => expect(reader.canRead(1)).toBe(true));
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  it('drops an endpoint that serves another chain, for good, and never reads from it', async () => {
    const { reader, rpc, read, lines, tick } = setup({
      [A]: { chainId: 8453 },
      [B]: { tokens: new Map<string, TokenAnswer>([[USDC, 7n]]) },
    });
    await reader.verifyEndpoints();
    expect(reader.canRead(1)).toBe(true);
    const result = await read();
    expect(result.tokens).toEqual([7n, null]);
    expect(rpc.callsTo(A).map((c) => c.method)).toEqual(['eth_chainId']);
    expect(lines.find((l) => l.level === 'error')).toEqual({
      level: 'error',
      obj: { chainId: 1, endpoint: 'E[0]' },
      msg: 'RPC endpoint serves another chain; dropped (check its env var)',
    });
    tick(10 * 60_000);
    await reader.verifyEndpoints();
    expect(rpc.callsTo(A)).toHaveLength(1);
    expectNoSecrets(lines);
  });

  it('retries an unreachable endpoint later, and not before reverifyAfterMs', async () => {
    const { reader, rpc, read, tick, lines } = setup(
      { [A]: { mode: 'down' } },
      { reverifyAfterMs: 1_000 },
    );
    await reader.verifyEndpoints();
    expect(reader.canRead(1)).toBe(false);
    expect(lines.at(-1)).toMatchObject({
      level: 'warn',
      obj: { chainId: 1, endpoint: 'E[0]', error: 'HttpRequestError' },
      msg: 'RPC endpoint unreachable; will retry',
    });
    rpc.nodes.get(A)!.mode = 'ok';
    await failure(read());
    expect(rpc.callsTo(A)).toHaveLength(1); // too early: not asked again
    tick(1_000);
    await failure(read());
    await vi.waitFor(() => expect(reader.canRead(1)).toBe(true));
    expect(rpc.callsTo(A)).toHaveLength(2);
    expectNoSecrets(lines);
  });

  it('keeps an endpoint pending when it answers a malformed chain ID', async () => {
    const { reader, lines } = setup({ [A]: { results: { eth_chainId: 'one' } } });
    await reader.verifyEndpoints();
    expect(reader.canRead(1)).toBe(false);
    expect(lines.at(-1)?.msg).toBe('RPC endpoint returned a malformed chain ID; will retry');
  });

  it('does not ask the same endpoint twice at once', async () => {
    const { reader, rpc } = setup({ [A]: {} });
    await Promise.all([reader.verifyEndpoints(), reader.verifyEndpoints()]);
    expect(rpc.calls).toHaveLength(1);
  });

  it('refuses a chain it has no endpoints for, and skips empty endpoint lists', async () => {
    // Defaults throughout (no fetch is made: nothing is verified).
    const reader = new ViemChainReader({
      endpoints: new Map([
        [8453, []],
        [1, [{ url: A, label: 'E[0]' }]],
      ]),
    });
    expect(reader.canRead(8453)).toBe(false);
    const err = await failure(
      reader.readBalances({ chainId: 8453, owner: OWNER, tokens: [] }, AbortSignal.timeout(100)),
    );
    expect(err.reason).toBe('chain_not_configured');
  });
});

describe('balance reads with Multicall3', () => {
  it('reads every balance in one eth_call pinned to the block it just read', async () => {
    const { reader, rpc, read } = setup({
      [A]: {
        block: 4242n,
        native: 9n,
        tokens: new Map<string, TokenAnswer>([
          [USDC, 1_000_000n],
          [DAI, 0n],
        ]),
      },
    });
    await reader.verifyEndpoints();
    const result = await read();
    expect(result).toEqual({ blockNumber: 4242n, native: 9n, tokens: [1_000_000n, 0n] });
    const reads = rpc.calls.slice(1);
    expect(reads.map((c) => c.method)).toEqual(['eth_blockNumber', 'eth_call']);
    expect(reads[1]?.params[1]).toBe(toHex(4242n));
    expect((reads[1]?.params[0] as { to: string }).to).toBe(MC);
  });

  it('isolates per-token failures: revert, no code, malformed return data are null', async () => {
    const T3 = '0x1111111111111111111111111111111111111111';
    const T4 = '0x2222222222222222222222222222222222222222';
    const { reader, read, lines } = setup({
      [A]: {
        tokens: new Map<string, TokenAnswer>([
          [USDC, 'revert'],
          // DAI absent: an address without code answers empty data.
          [T3, { raw: `0x${'00'.repeat(33)}` }],
          [T4, 5n],
        ]),
      },
    });
    await reader.verifyEndpoints();
    const result = await read([USDC, DAI, T3, T4]);
    expect(result.tokens).toEqual([null, null, null, 5n]);
    expect(result.native).toBe(5n * 10n ** 18n);
    expect(lines.at(-1)).toEqual({
      level: 'info',
      obj: { chainId: 1, failedTokens: 3, nativeFailed: false },
      msg: 'some balance reads failed',
    });
  });

  it('reports a failed native read as null', async () => {
    const { reader, read } = setup({
      [A]: {
        aggregateResults: (r) =>
          r.map((x, i) => (i === 2 ? { success: false, returnData: '0x' } : x)),
      },
    });
    await reader.verifyEndpoints();
    expect((await read([])).native).toBeNull();
  });

  it('fails over to the next endpoint on a connection error, HTTP 500 or 429', async () => {
    for (const mode of ['down', 'http500', 'http429'] as const) {
      const { reader, rpc, read, lines } = setup({
        [A]: {},
        [B]: { tokens: new Map<string, TokenAnswer>([[USDC, 3n]]) },
      });
      await reader.verifyEndpoints();
      rpc.nodes.get(A)!.mode = mode;
      const result = await read();
      expect(result.tokens[0], mode).toBe(3n);
      expect(rpc.callsTo(B, 'eth_call')).toHaveLength(1);
      expectNoSecrets(lines);
    }
  });

  it('prefers the first healthy endpoint', async () => {
    const { reader, rpc, read } = setup({ [A]: {}, [B]: {} });
    await reader.verifyEndpoints();
    await read();
    await read();
    expect(rpc.callsTo(A, 'eth_call')).toHaveLength(2);
    expect(rpc.callsTo(B, 'eth_call')).toHaveLength(0);
  });

  it('times out a hanging endpoint per request and moves on', async () => {
    const { reader, rpc, read } = setup({ [A]: {}, [B]: {} }, { requestTimeoutMs: 50 });
    await reader.verifyEndpoints();
    rpc.nodes.get(A)!.mode = 'hang';
    const started = Date.now();
    const result = await read();
    expect(result.blockNumber).toBe(1_000n);
    expect(Date.now() - started).toBeLessThan(1_000);
    // The hung request was aborted, not left running.
    expect(rpc.signals.some((s) => s.aborted)).toBe(true);
  });

  it('fails with `timeout` when every endpoint times out', async () => {
    const { reader, rpc, read, lines } = setup({ [A]: {}, [B]: {} }, { requestTimeoutMs: 30 });
    await reader.verifyEndpoints();
    rpc.nodes.get(A)!.mode = 'hang';
    rpc.nodes.get(B)!.mode = 'hang';
    const err = await failure(read());
    expect([err.code, err.reason]).toEqual(['timeout', 'rpc_timeout']);
    expectNoSecrets(lines, [err]);
  });

  it('fails with `rpc_unavailable` when every endpoint errors, and logs no secrets', async () => {
    const { reader, rpc, read, lines } = setup({ [A]: {}, [B]: {} }, { retryCount: 1 });
    await reader.verifyEndpoints();
    rpc.nodes.get(A)!.mode = 'http500';
    rpc.nodes.get(B)!.mode = 'down';
    const err = await failure(read());
    expect([err.code, err.reason]).toEqual(['rpc_unavailable', 'rpc_error']);
    // Bounded: one pass plus one retry, two endpoints each.
    expect(rpc.calls.filter((c) => c.method === 'eth_blockNumber')).toHaveLength(4);
    expect(lines.at(-1)).toMatchObject({ level: 'warn', msg: 'balance read failed' });
    expectNoSecrets(lines, [err]);
  });

  it('does not retry or fail over a deterministic error (the aggregate call reverted)', async () => {
    const { reader, rpc, read } = setup({ [A]: {}, [B]: {} }, { retryCount: 2 });
    await reader.verifyEndpoints();
    rpc.nodes.get(A)!.mode = 'revert-call';
    // eth_blockNumber still answers in this mode; only eth_call reverts.
    const err = await failure(read());
    expect(err.code).toBe('rpc_unavailable');
    expect(rpc.callsTo(A, 'eth_call')).toHaveLength(1);
    expect(rpc.callsTo(B)).toHaveLength(1); // its eth_chainId only
  });

  it('aborts outstanding requests when the caller signal aborts', async () => {
    // No per-request timeout at all: only the caller's signal can end the hang.
    const { reader, rpc, read } = setup({ [A]: {} }, { requestTimeoutMs: 0 });
    await reader.verifyEndpoints();
    rpc.nodes.get(A)!.mode = 'hang';
    const controller = new AbortController();
    const pending = read(undefined, controller.signal);
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(2));
    controller.abort();
    const err = await failure(pending);
    expect([err.code, err.reason]).toEqual(['timeout', 'deadline']);
    expect(rpc.signals.at(-1)?.aborted).toBe(true);
  });

  it('refuses an already aborted signal without a request', async () => {
    const { reader, rpc, read } = setup({ [A]: {} });
    await reader.verifyEndpoints();
    const err = await failure(read(undefined, AbortSignal.abort()));
    expect(err.reason).toBe('aborted');
    expect(rpc.calls).toHaveLength(1);
  });
});

describe('bad data from an endpoint', () => {
  async function readWith(n: Partial<FakeNode>, opts: Partial<ViemChainReaderOptions> = {}) {
    const s = setup({ [A]: n }, opts);
    await s.reader.verifyEndpoints();
    return { ...s, err: await failure(s.read()) };
  }

  it.each([
    ['not hex', { results: { eth_blockNumber: '0xzz' } }, 'malformed_block_number'],
    ['a number', { results: { eth_blockNumber: 12 } }, 'malformed_block_number'],
    ['empty', { results: { eth_blockNumber: '0x' } }, 'malformed_block_number'],
    ['leading zero', { results: { eth_blockNumber: '0x01' } }, 'malformed_block_number'],
    [
      'over 32 bytes',
      { results: { eth_blockNumber: `0x1${'0'.repeat(64)}` } },
      'malformed_block_number',
    ],
    ['zero', { block: 0n }, 'implausible_block_number'],
    ['above 2^53', { block: 2n ** 53n + 1n }, 'implausible_block_number'],
  ])('refuses a block number that is %s', async (_name, n, reason) => {
    const { err } = await readWith(n as Partial<FakeNode>);
    expect([err.code, err.reason]).toEqual(['rpc_unavailable', reason]);
  });

  it.each([
    ['not hex', { results: { eth_call: 'nope' } }],
    ['undecodable', { aggregateRaw: '0x1234' as const }],
    ['the wrong number of results', { aggregateResults: (r: unknown[]) => r.slice(1) }],
    [
      'a failed chain ID call',
      {
        aggregateResults: (r: { success: boolean; returnData: `0x${string}` }[]) =>
          r.map((x, i) => (i === 0 ? { success: false, returnData: '0x' as const } : x)),
      },
    ],
    [
      'a failed timestamp call',
      {
        aggregateResults: (r: { success: boolean; returnData: `0x${string}` }[]) =>
          r.map((x, i) => (i === 1 ? { success: false, returnData: '0x' as const } : x)),
      },
    ],
    [
      'a short timestamp word',
      {
        aggregateResults: (r: { success: boolean; returnData: `0x${string}` }[]) =>
          r.map((x, i) => (i === 1 ? { success: true, returnData: '0x01' as const } : x)),
      },
    ],
  ])('refuses an aggregate3 result that is %s', async (_name, n) => {
    const { err, lines } = await readWith(n as Partial<FakeNode>);
    expect([err.code, err.reason]).toEqual(['rpc_unavailable', 'malformed_call_result']);
    expect(lines.at(-1)).toMatchObject({ obj: { reason: 'malformed_call_result' } });
  });

  it('refuses balances from another chain and re-checks every endpoint', async () => {
    const { err, reader, rpc, lines } = await readWith({ callChainId: 10 });
    expect(err.reason).toBe('chain_id_mismatch');
    expect(lines.some((l) => l.level === 'error' && l.msg.includes('another chain'))).toBe(true);
    // Re-verification ran (eth_chainId still says 1, so it is trusted again).
    await vi.waitFor(() => expect(rpc.callsTo(A, 'eth_chainId')).toHaveLength(2));
    await vi.waitFor(() => expect(reader.canRead(1)).toBe(true));
  });

  it('after a mismatch inside a call, re-checks only endpoints that were trusted', async () => {
    const { reader, rpc, read } = setup({ [A]: { callChainId: 10 }, [B]: { mode: 'down' } });
    await reader.verifyEndpoints();
    rpc.nodes.get(B)!.mode = 'ok';
    expect((await failure(read())).reason).toBe('chain_id_mismatch');
    // Both are asked again at once: A (reset to pending) and B (still pending).
    await vi.waitFor(() => expect(rpc.callsTo(B, 'eth_chainId')).toHaveLength(2));
    await vi.waitFor(() => expect(reader.canRead(1)).toBe(true));
  });

  it('refuses a stale block and a block from the future', async () => {
    const stale = await readWith({ timestamp: T0 - 400n });
    expect(stale.err.reason).toBe('stale_block');
    const future = await readWith({ timestamp: T0 + 100n });
    expect(future.err.reason).toBe('block_in_future');
  });

  it('refuses a rewound or inconsistent block against the newest one seen, for a while', async () => {
    const { reader, rpc, read, tick } = setup({ [A]: { block: 100n, timestamp: T0 } });
    await reader.verifyEndpoints();
    await read();
    const n = rpc.nodes.get(A)!;
    // 60 s older than the newest block seen.
    n.block = 90n;
    n.timestamp = T0 - 60n;
    expect((await failure(read())).reason).toBe('block_rewound');
    // A lower block number with a much later time.
    n.timestamp = T0 + 40n;
    tick(40_000);
    expect((await failure(read())).reason).toBe('inconsistent_block');
    // Slightly behind (another endpoint a few blocks back) is fine.
    n.block = 99n;
    n.timestamp = T0 - 2n;
    expect((await read()).blockNumber).toBe(99n);
    // The newest block is forgotten after highWaterTtlMs, so one bad answer cannot block a chain.
    n.block = 50n;
    n.timestamp = T0 - 50n;
    expect((await failure(read())).reason).toBe('block_rewound');
    tick(61_000);
    n.timestamp = T0 + 60n;
    expect((await read()).blockNumber).toBe(50n);
  });
});

describe('balance reads without Multicall3', () => {
  const opts = { multicallChains: new Set<number>() };

  it('pins every request to the same block and isolates reverting tokens', async () => {
    const { reader, rpc, read } = setup(
      {
        [A]: {
          block: 77n,
          native: 4n,
          tokens: new Map<string, TokenAnswer>([
            [USDC, 'revert'],
            [DAI, 6n],
          ]),
        },
      },
      opts,
    );
    await reader.verifyEndpoints();
    const result = await read();
    expect(result).toEqual({ blockNumber: 77n, native: 4n, tokens: [null, 6n] });
    const reads = rpc.calls.slice(1);
    expect(reads.map((c) => c.method).sort()).toEqual(
      [
        'eth_blockNumber',
        'eth_call',
        'eth_call',
        'eth_chainId',
        'eth_getBalance',
        'eth_getBlockByNumber',
      ].sort(),
    );
    for (const c of reads.filter((c) => c.method === 'eth_call' || c.method === 'eth_getBalance')) {
      expect(c.params[1]).toBe(toHex(77n));
    }
  });

  it('treats an address without code or a malformed token answer as null', async () => {
    const { reader, read } = setup(
      { [A]: { tokens: new Map<string, TokenAnswer>([[DAI, { raw: '0x12' }]]) } },
      opts,
    );
    await reader.verifyEndpoints();
    expect((await read()).tokens).toEqual([null, null]);
  });

  it('fails the whole read when a token call fails for another reason than a revert', async () => {
    const { reader, rpc, read } = setup({ [A]: {} }, opts);
    await reader.verifyEndpoints();
    rpc.nodes.get(A)!.results = { eth_call: 42 };
    // A non-string result is null, not a failure...
    expect((await read()).tokens).toEqual([null, null]);
    // ...but an RPC error that is not a revert fails the read.
    rpc.nodes.get(A)!.results = {};
    rpc.nodes.get(A)!.mode = 'ok';
    const original = rpc.fetch;
    const failing: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      if (body.method === 'eth_call') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32602, message: 'invalid params' },
        });
      }
      return original(input, init);
    };
    const r2 = new ViemChainReader({
      endpoints: new Map([[1, [{ url: A, label: 'E[0]' }]]]),
      fetch: failing,
      now: () => Number(T0) * 1000,
      retryCount: 0,
      multicallChains: new Set(),
    });
    await r2.verifyEndpoints();
    const err = await failure(
      r2.readBalances({ chainId: 1, owner: OWNER, tokens: [USDC] }, AbortSignal.timeout(1_000)),
    );
    expect(err.reason).toBe('rpc_error');
  });

  it('refuses a missing or mismatched block, and a malformed chain ID or balance', async () => {
    for (const [results, reason] of [
      [{ eth_getBlockByNumber: null }, 'malformed_block'],
      [{ eth_getBlockByNumber: 'x' }, 'malformed_block'],
      [{ eth_getBlockByNumber: { number: '0x1', timestamp: toHex(T0) } }, 'malformed_block'],
      [{ eth_getBlockByNumber: { number: toHex(1_000n), timestamp: 'late' } }, 'malformed_block'],
      [{ eth_getBalance: '-1' }, 'malformed_balance'],
    ] as const) {
      const { reader, read, rpc } = setup({ [A]: {} }, opts);
      await reader.verifyEndpoints();
      rpc.nodes.get(A)!.results = results;
      expect((await failure(read())).reason).toBe(reason);
    }
    const { reader, read, rpc } = setup({ [A]: {} }, opts);
    await reader.verifyEndpoints();
    rpc.nodes.get(A)!.chainId = 5;
    expect((await failure(read())).reason).toBe('chain_id_mismatch');
  });
});

describe('ranking (viem fallback rank)', () => {
  it('moves an endpoint that fails its pings behind a healthy one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { reader, rpc, read } = setup({ [A]: {}, [B]: {} }, { rank: { intervalMs: 1_000 } });
    await reader.verifyEndpoints();
    // A hangs until its ping times out: unstable and slow. (viem divides by the largest
    // latency seen, so the samples need one non-zero latency under fake time.)
    rpc.nodes.get(A)!.mode = 'hang';
    await vi.advanceTimersByTimeAsync(3_000);
    const pings = rpc.callsTo(B, 'eth_blockNumber').length;
    expect(pings).toBeGreaterThan(0);
    rpc.nodes.get(A)!.mode = 'ok';
    const before = rpc.callsTo(A, 'eth_call').length;
    await read();
    expect(rpc.callsTo(A, 'eth_call')).toHaveLength(before);
    expect(rpc.callsTo(B, 'eth_call')).toHaveLength(1);
  });
});

describe('describeError', () => {
  it('keeps the class name, HTTP status and JSON-RPC code only', () => {
    const http = new HttpRequestError({ url: A, status: 503, body: { owner: OWNER } });
    expect(describeError(http)).toEqual({ error: 'HttpRequestError', status: 503 });
    const rpcErr = new RpcRequestError({
      body: {},
      error: { code: -32005, message: `k ${A}` },
      url: B,
    });
    expect(describeError(rpcErr)).toEqual({ error: 'RpcRequestError', code: -32005 });
    expect(describeError(new TypeError(`fetch ${A}`))).toEqual({ error: 'TypeError' });
    expect(describeError({ message: A })).toEqual({ error: 'object' });
    expect(describeError(A)).toEqual({ error: 'string' });
    expectNoSecrets([], [JSON.stringify([describeError(http), describeError(rpcErr)])]);
  });
});

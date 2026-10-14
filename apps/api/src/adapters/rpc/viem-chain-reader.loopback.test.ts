import { afterEach, describe, expect, it } from 'vitest';
import { FakeRpc, node } from '../../testing/fake-rpc.js';
import { closeAll, loopback, type Loopback } from '../../testing/loopback.js';
import {
  ViemChainReader,
  type ReaderLog,
  type ViemChainReaderOptions,
} from './viem-chain-reader.js';

/**
 * Against real loopback servers and Node's real fetch:
 * - redirects: a 3xx must never send anything to the redirect target (it would carry the
 *   request body, wallet address included, to a host nobody configured, and bypass the chain
 *   ID proof);
 * - stalled bodies: an endpoint that sends `200`, headers and part of a body, then hangs, must
 *   fail within the per-request budget so the next endpoint serves (viem's own timeout ends at
 *   the headers).
 */

const OWNER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const T0 = 1_700_000_000;

afterEach(closeAll);

/** A loopback JSON-RPC server answering from a FakeRpc node (chain 1). */
async function rpcServer(rpc: FakeRpc): Promise<Loopback> {
  const lb = await loopback(async (req) => {
    const answer = await rpc.fetch(lb.url, { method: 'POST', body: req.body });
    return { status: answer.status, body: await answer.text() };
  });
  rpc.nodes.set(lb.url, node({ timestamp: BigInt(T0), tokens: new Map([[USDC, 9n]]) }));
  return lb;
}

async function setup(opts: Partial<ViemChainReaderOptions> = {}) {
  const rpc = new FakeRpc();
  const [first, second, target] = [
    await rpcServer(rpc),
    await rpcServer(rpc),
    await rpcServer(rpc),
  ];
  const lines: { obj: Record<string, unknown>; msg: string }[] = [];
  const log: ReaderLog = {
    info: (obj, msg) => lines.push({ obj, msg }),
    warn: (obj, msg) => lines.push({ obj, msg }),
    error: (obj, msg) => lines.push({ obj, msg }),
  };
  const reader = new ViemChainReader({
    endpoints: new Map([
      [
        1,
        [
          { url: first.url, label: 'RPC_URLS_EVM_1[0]' },
          { url: second.url, label: 'RPC_URLS_EVM_1[1]' },
        ],
      ],
    ]),
    log,
    retryCount: 0,
    requestTimeoutMs: 2_000,
    now: () => T0 * 1000,
    ...opts,
  });
  return { first, second, target, reader, lines };
}

const read = (reader: ViemChainReader, deadlineMs = 5_000) =>
  reader.readBalances(
    { chainId: 1, owner: OWNER, tokens: [USDC] },
    AbortSignal.timeout(deadlineMs),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each([301, 302, 307, 308])('an RPC endpoint answering %i', (status) => {
  it('is refused for reads, the target gets nothing, and the next endpoint serves', async () => {
    const { first, second, target, reader, lines } = await setup();
    await reader.verifyEndpoints();
    expect(reader.canRead(1)).toBe(true);
    first.behaviour = { kind: 'redirect', status, location: target.url };
    const result = await read(reader);
    expect(result.tokens).toEqual([9n]);
    expect(first.received.some((r) => r.body.includes('eth_blockNumber'))).toBe(true);
    expect(target.received).toEqual([]);
    expect(second.received.some((r) => r.body.includes('eth_call'))).toBe(true);
    expect(lines).toContainEqual({
      obj: { chainId: 1, endpoint: 'RPC_URLS_EVM_1[0]', reason: 'redirect' },
      msg: 'RPC endpoint answered with a redirect; refused',
    });
    expect(JSON.stringify(lines)).not.toMatch(/127\.0\.0\.1|http:/);
  });

  it('fails the chain ID proof, and the target gets nothing', async () => {
    const { first, second, target, reader, lines } = await setup();
    first.behaviour = { kind: 'redirect', status, location: target.url };
    await reader.verifyEndpoints();
    expect(target.received).toEqual([]);
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);
    expect(lines).toContainEqual({
      obj: { chainId: 1, endpoint: 'RPC_URLS_EVM_1[0]', reason: 'redirect' },
      msg: 'RPC endpoint answered with a redirect; refused',
    });
    // Only the second endpoint proved itself; reads use it alone.
    const result = await read(reader);
    expect(result.tokens).toEqual([9n]);
    expect(first.received).toHaveLength(1);
    expect(target.received).toEqual([]);
  });
});

describe('an RPC endpoint that sends headers and part of a body, then stalls', () => {
  it('is abandoned after the request timeout on reads, and the next endpoint serves', async () => {
    const { first, second, reader } = await setup({ requestTimeoutMs: 300 });
    await reader.verifyEndpoints();
    first.behaviour = { kind: 'stall' };
    const started = Date.now();
    const result = await read(reader, 5_000);
    const elapsed = Date.now() - started;
    expect(result.tokens).toEqual([9n]);
    // One stalled request (eth_blockNumber) costs one request timeout, not the 5 s deadline.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_500);
    expect(second.received.some((r) => r.body.includes('eth_call'))).toBe(true);
  });

  it('fails with `timeout` when every endpoint stalls, within the request budget', async () => {
    const { first, second, reader, lines } = await setup({ requestTimeoutMs: 300 });
    await reader.verifyEndpoints();
    first.behaviour = { kind: 'stall' };
    second.behaviour = { kind: 'stall' };
    const started = Date.now();
    const err = await read(reader, 5_000).then(
      () => undefined,
      (e: unknown) => e as { code?: string; reason?: string },
    );
    expect([err?.code, err?.reason]).toEqual(['timeout', 'rpc_timeout']);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.stringify(lines)).not.toMatch(/127\.0\.0\.1|http:/);
  });

  it('fails the chain ID proof after the proof timeout', async () => {
    const { first, reader } = await setup({ verifyTimeoutMs: 300 });
    first.behaviour = { kind: 'stall' };
    const started = Date.now();
    await reader.verifyEndpoints();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(reader.canRead(1)).toBe(true); // the second endpoint proved itself
    const result = await read(reader);
    expect(result.tokens).toEqual([9n]);
    expect(first.received).toHaveLength(1);
  });

  it('does not freeze endpoint ranking', async () => {
    const { first, second, reader } = await setup({
      requestTimeoutMs: 200,
      rank: { intervalMs: 100 },
    });
    await reader.verifyEndpoints();
    first.behaviour = { kind: 'stall' };
    const pings = () => second.received.filter((r) => r.body.includes('eth_blockNumber')).length;
    await sleep(300);
    const before = pings();
    await sleep(1_500);
    // A round takes at most one request timeout plus the interval: several rounds ran.
    expect(pings() - before).toBeGreaterThanOrEqual(3);
  });
});

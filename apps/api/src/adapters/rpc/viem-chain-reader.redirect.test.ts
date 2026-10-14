import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRpc, node } from '../../testing/fake-rpc.js';
import { ViemChainReader, type ReaderLog } from './viem-chain-reader.js';

/**
 * Redirects against real loopback servers and Node's real fetch: a 3xx from an RPC endpoint
 * must never send anything to the redirect target (it would carry the request body, wallet
 * address included, to a host nobody configured, and bypass the chain ID proof).
 */

const OWNER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const T0 = 1_700_000_000;

interface Loopback {
  url: string;
  /** Requests received: method and body. */
  received: { method: string | undefined; body: string }[];
  /** When set, every request is answered with this redirect to `location`. */
  redirect?: { status: number; location: string } | undefined;
  server: Server;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** A loopback JSON-RPC server answering from a FakeRpc node (chain 1). */
async function loopback(rpc: FakeRpc): Promise<Loopback> {
  const lb = { received: [] } as unknown as Loopback;
  const server = createServer((req, res) => {
    void readBody(req).then(async (body) => {
      lb.received.push({ method: req.method, body });
      if (lb.redirect) {
        res.writeHead(lb.redirect.status, { location: lb.redirect.location });
        res.end();
        return;
      }
      const answer = await rpc.fetch(lb.url, { method: 'POST', body });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(await answer.text());
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  lb.server = server;
  lb.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  rpc.nodes.set(lb.url, node({ timestamp: BigInt(T0), tokens: new Map([[USDC, 9n]]) }));
  return lb;
}

async function setup() {
  const rpc = new FakeRpc();
  const [first, second, target] = [await loopback(rpc), await loopback(rpc), await loopback(rpc)];
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
  });
  return { first, second, target, reader, lines };
}

const read = (reader: ViemChainReader) =>
  reader.readBalances({ chainId: 1, owner: OWNER, tokens: [USDC] }, AbortSignal.timeout(5_000));

describe.each([301, 302, 307, 308])('an RPC endpoint answering %i', (status) => {
  it('is refused for reads, the target gets nothing, and the next endpoint serves', async () => {
    const { first, second, target, reader, lines } = await setup();
    await reader.verifyEndpoints();
    expect(reader.canRead(1)).toBe(true);
    first.redirect = { status, location: target.url };
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
    first.redirect = { status, location: target.url };
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

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAll, loopback, type Received } from '../../src/testing/loopback.js';
import {
  assertLoopbackRpcUrl,
  HarnessRpcRefusedError,
  LOCAL_CHAIN_ID_HEX,
  verifyLocalChain,
} from './rpc-guard.js';
import { runSmoke } from './smoke.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAll();
});

function methods(received: Received[]): string[] {
  return received.map((r) => {
    const body: unknown = JSON.parse(r.body);
    return typeof body === 'object' && body !== null && 'method' in body
      ? String(body.method)
      : 'unknown';
  });
}

/** A JSON-RPC endpoint on 127.0.0.1 answering eth_chainId with `chainIdHex`, errors otherwise. */
function rpc(chainIdHex: string) {
  return loopback((req) => {
    const body = JSON.parse(req.body) as { id: number; method: string };
    const answer =
      body.method === 'eth_chainId'
        ? { jsonrpc: '2.0', id: body.id, result: chainIdHex }
        : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not here' } };
    return Promise.resolve({ status: 200, body: JSON.stringify(answer) });
  });
}

describe('assertLoopbackRpcUrl', () => {
  it.each(['http://127.0.0.1:8545', 'http://127.0.0.1:8545/', 'http://[::1]:8780'])(
    'accepts %s',
    (url) => {
      expect(assertLoopbackRpcUrl(url)).toBe(url.replace(/\/$/, ''));
    },
  );

  it.each([
    undefined,
    '',
    'https://127.0.0.1:8545',
    'ws://127.0.0.1:8545',
    'HTTP://127.0.0.1:8545',
    ' http://127.0.0.1:8545',
    'http://localhost:8545',
    'http://127.0.0.2:8545',
    'http://127.1:8545',
    'http://0x7f.0.0.1:8545',
    'http://2130706433:8545',
    'http://[::ffff:127.0.0.1]:8545',
    'http://[0:0:0:0:0:0:0:1]:8545',
    'http://0.0.0.0:8545',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:08545',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:3000',
    'http://user:pw@127.0.0.1:8545',
    'http://127.0.0.1:8545/rpc',
    'http://127.0.0.1:8545?x=1',
    'http://127.0.0.1:8545#x',
    'http://127.0.0.1.evil.example:8545',
    'http://127.0.0.1@evil.example:8545',
    'https://mainnet.base.org',
    'http://10.0.0.5:8545',
  ])('refuses %s without any network access', (url) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(() => assertLoopbackRpcUrl(url)).toThrow(HarnessRpcRefusedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('runSmoke refusals happen before anything is sent', () => {
  it('a non-loopback spelling of a live endpoint that answers 31337 gets no request at all', async () => {
    const server = await rpc('0x7a69');
    const port = new URL(server.url).port;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const url of [
      `http://localhost:${port}`,
      `http://127.1:${port}`,
      `https://127.0.0.1:${port}`,
    ]) {
      await expect(runSmoke(url)).rejects.toBeInstanceOf(HarnessRpcRefusedError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(server.received).toEqual([]);
  });

  it.each([
    ['0x1', 'Ethereum'],
    ['0x2105', 'Base'],
    ['0x14a34', 'Base Sepolia'],
  ])('a loopback endpoint answering %s (%s) gets only eth_chainId', async (chainId) => {
    const server = await rpc(chainId);
    await expect(runSmoke(server.url)).rejects.toBeInstanceOf(HarnessRpcRefusedError);
    expect(methods(server.received)).toEqual(['eth_chainId']);
  });

  it('a redirect is refused, and its target gets nothing', async () => {
    const target = await rpc('0x7a69');
    const redirector = await rpc('0x7a69');
    redirector.behaviour = { kind: 'redirect', status: 307, location: target.url };
    await expect(runSmoke(redirector.url)).rejects.toBeInstanceOf(HarnessRpcRefusedError);
    expect(methods(redirector.received)).toEqual(['eth_chainId']);
    expect(target.received).toEqual([]);
  });

  it('a 31337 endpoint without the pinned contracts gets reads only, never a transaction', async () => {
    const server = await rpc('0x7a69');
    const report = await runSmoke(server.url);
    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.ok).toBe(false);
    const sent = methods(server.received);
    expect(sent[0]).toBe('eth_chainId');
    expect(sent.filter((m) => /send|sign/i.test(m))).toEqual([]);
  });
});

describe('verifyLocalChain', () => {
  it('accepts an endpoint answering 31337', async () => {
    const server = await rpc('0x7a69');
    await expect(verifyLocalChain(server.url)).resolves.toBeUndefined();
  });

  it('refuses a non-loopback URL before fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(verifyLocalChain('http://localhost:8545', { fetch: fetchImpl })).rejects.toThrow(
      HarnessRpcRefusedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a malformed answer', async () => {
    const server = await loopback(() => Promise.resolve({ status: 200, body: '{"result":31337}' }));
    await expect(verifyLocalChain(server.url)).rejects.toThrow(HarnessRpcRefusedError);
  });
});

describe('the 31337 rail is a literal (PR 3 review, M1)', () => {
  it('LOCAL_CHAIN_ID_HEX is exactly 0x7a69, written as a literal in rpc-guard.ts', () => {
    expect(LOCAL_CHAIN_ID_HEX).toBe('0x7a69');
    const src = readFileSync(new URL('./rpc-guard.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/export const LOCAL_CHAIN_ID_HEX = '0x7a69';/);
    expect(src).not.toMatch(/from '.\/pinned\.js'|local-dev/);
  });

  it('anvil --chain-id and the smoke local key allowlist are the literal 31337', () => {
    const anvil = readFileSync(new URL('./anvil.ts', import.meta.url), 'utf8');
    expect(anvil).toMatch(/'--chain-id',\s*'31337'/);
    const smoke = readFileSync(new URL('./smoke.ts', import.meta.url), 'utf8');
    expect(smoke).toMatch(/allowedChainIds: \[31337\]/);
  });
});

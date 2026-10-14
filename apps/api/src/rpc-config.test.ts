import { PUBLIC_RPC_URLS } from '@ranvier/chains';
import { describe, expect, it } from 'vitest';
import {
  loadRpcConfig,
  MAX_RPC_URLS_PER_CHAIN,
  parseRpcUrlList,
  rpcEnvName,
} from './rpc-config.js';

const KEY = 'SECRETKEY123';

/** The thrown message, checked to never quote the value. */
function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err: unknown) {
    const message = (err as Error).message;
    expect(message).not.toContain(KEY);
    expect(message).not.toMatch(/example|:\/\//);
    return message;
  }
  throw new Error('expected a throw');
}

describe('parseRpcUrlList', () => {
  it('accepts trimmed https URLs (keys in path, query or user info) in order', () => {
    expect(
      parseRpcUrlList(
        'RPC_URLS_EVM_1',
        ` https://a.example/v2/${KEY} ,https://u:${KEY}@b.example/?k=${KEY}`,
      ),
    ).toEqual([`https://a.example/v2/${KEY}`, `https://u:${KEY}@b.example/?k=${KEY}`]);
  });

  it('accepts plain http for loopback hosts only', () => {
    expect(
      parseRpcUrlList('V', 'http://localhost:8545,http://127.0.0.1:8545,http://[::1]:8545'),
    ).toHaveLength(3);
    expect(errorOf(() => parseRpcUrlList('V', `http://rpc.example/${KEY}`))).toBe(
      'V entry 1 must use https unless the host is loopback (value not shown)',
    );
  });

  it.each([
    [`https://a.example/${KEY},`, 'V entry 2 is empty'],
    [`,https://a.example/${KEY}`, 'V entry 1 is empty'],
    [`not a url ${KEY}`, 'V entry 1 is not a valid URL (value not shown)'],
    [`wss://a.example/${KEY}`, 'V entry 1 must be an https URL (value not shown)'],
    [`ftp://a.example/${KEY}`, 'V entry 1 must be an https URL (value not shown)'],
    [`https://a.example/${KEY}#x`, 'V entry 1 must not have a fragment (value not shown)'],
    [`https://a.example/${KEY},https://a.example/${KEY}`, 'V entry 2 repeats an earlier entry'],
    [
      Array.from(
        { length: MAX_RPC_URLS_PER_CHAIN + 1 },
        (_v, i) => `https://h${i}.example/${KEY}`,
      ).join(','),
      `V lists more than ${MAX_RPC_URLS_PER_CHAIN} URLs`,
    ],
  ])('refuses %#, naming the entry but never its value', (raw, message) => {
    expect(errorOf(() => parseRpcUrlList('V', raw))).toBe(message);
  });
});

describe('loadRpcConfig', () => {
  it('uses the variable when set, else the public defaults, and labels endpoints without URLs', () => {
    const cfg = loadRpcConfig(
      {
        [rpcEnvName(1)]: `https://a.example/${KEY},https://b.example/${KEY}`,
        RPC_URLS_EVM_8453: ' ',
      },
      [1, 8453],
    );
    expect(cfg.endpoints.get(1)).toEqual([
      { url: `https://a.example/${KEY}`, label: 'RPC_URLS_EVM_1[0]' },
      { url: `https://b.example/${KEY}`, label: 'RPC_URLS_EVM_1[1]' },
    ]);
    expect(cfg.endpoints.get(8453)).toEqual(
      PUBLIC_RPC_URLS['evm:8453']?.map((url, i) => ({ url, label: `public-default:8453[${i}]` })),
    );
    expect(cfg.publicDefaultChains).toEqual([8453]);
    expect(cfg.ignored).toEqual([]);
    for (const e of [...cfg.endpoints.values()].flat())
      expect(e.label).not.toMatch(/example|:\/\//);
  });

  it('leaves a chain without a variable or default without endpoints', () => {
    const cfg = loadRpcConfig({}, [1, 777], {});
    expect([...cfg.endpoints.keys()]).toEqual([]);
    expect(cfg.publicDefaultChains).toEqual([]);
  });

  it('reports variables for other chains by name, and ignores unrelated variables', () => {
    const cfg = loadRpcConfig(
      { RPC_URLS_EVM_10: `https://x.example/${KEY}`, VERIFY_RPC_EVM_1: 'x', PATH: '/bin' },
      [1],
    );
    expect(cfg.ignored).toEqual(['RPC_URLS_EVM_10']);
  });

  it('refuses a malformed variable name or value, for any chain', () => {
    expect(errorOf(() => loadRpcConfig({ RPC_URLS_EVM_01: 'x' }, [1]))).toBe(
      'RPC_URLS_EVM_01 is not a valid name: expected RPC_URLS_EVM_<chain ID>',
    );
    expect(errorOf(() => loadRpcConfig({ RPC_URLS_EVM_: 'x' }, [1]))).toMatch(/not a valid name/);
    expect(errorOf(() => loadRpcConfig({ RPC_URLS_EVM_1: `http://rpc.example/${KEY}` }, [1]))).toBe(
      'RPC_URLS_EVM_1 entry 1 must use https unless the host is loopback (value not shown)',
    );
  });
});

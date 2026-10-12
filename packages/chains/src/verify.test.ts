import type { ChainKey } from '@ranvier/types';
import { describe, expect, it } from 'vitest';
import { ARB_STANDARD_GATEWAY, OP_STANDARD_BRIDGE, type CuratedToken } from './tokens.js';
import {
  decodeAddress,
  decodeString,
  decodeUint,
  diffToken,
  SELECTORS,
  verifyTokens,
  type LlamaCoin,
  type Observed,
  type VerifyDeps,
} from './verify.js';

const pad = (hex: string): string => hex.padStart(64, '0');
const encUint = (n: number | bigint): string => `0x${pad(BigInt(n).toString(16))}`;
const encAddress = (a: string): string => `0x${pad(a.slice(2))}`;
function encString(s: string): string {
  const bytes = Buffer.from(s, 'utf8').toString('hex');
  const padded = bytes.padEnd(Math.ceil(bytes.length / 64) * 64 || 64, '0');
  return `0x${pad('20')}${pad(bytes.length / 2 === 0 ? '0' : (bytes.length / 2).toString(16))}${padded}`;
}

const USDC: CuratedToken = {
  chain: 'evm:1',
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
};
const L1_UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const BASE_UNI: CuratedToken = {
  chain: 'evm:8453',
  address: '0xc3de830ea07524a0761646a6a4e4be0e114a3c83',
  symbol: 'UNI',
  name: 'Uniswap',
  decimals: 18,
  bridge: { kind: 'op-stack', l1Address: L1_UNI, gateway: OP_STANDARD_BRIDGE },
};
const ARB_UNI: CuratedToken = {
  ...BASE_UNI,
  chain: 'evm:42161',
  address: '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0',
  bridge: { kind: 'arbitrum', l1Address: L1_UNI, gateway: ARB_STANDARD_GATEWAY },
};
const USDT0: CuratedToken = {
  chain: 'evm:42161',
  address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  symbol: 'USDT0',
  onchainSymbol: 'USD₮0',
  name: 'USD₮0',
  decimals: 6,
};
const NATIVE: CuratedToken = {
  chain: 'evm:1',
  address: 'native',
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
};

/** A copy of `o` without `key`. */
function omit(o: Observed, key: 'onchain' | 'llama' | 'bridge'): Observed {
  const copy = { ...o };
  Reflect.deleteProperty(copy, key);
  return copy;
}

const good = (t: CuratedToken): Observed => ({
  onchain: { symbol: t.onchainSymbol ?? t.symbol, name: t.name, decimals: t.decimals },
  llama: { symbol: t.symbol, decimals: t.decimals, confidence: 0.99 },
  ...(t.bridge ? { bridge: { l1Address: t.bridge.l1Address, gateway: t.bridge.gateway } } : {}),
  errors: [],
});

describe('ABI decoding', () => {
  it('decodes uint, address and string results', () => {
    expect(decodeUint(encUint(6))).toBe(6n);
    expect(decodeAddress(encAddress(L1_UNI))).toBe(L1_UNI);
    expect(decodeString(encString('USD₮0'))).toBe('USD₮0');
    expect(decodeString(encString(''))).toBe('');
  });

  it('refuses malformed results', () => {
    expect(() => decodeUint('0x')).toThrow(/malformed/);
    expect(() => decodeUint('0x1234')).toThrow(/malformed/);
    expect(() => decodeAddress(`0x${'f'.repeat(64)}`)).toThrow(/dirty/);
    expect(() => decodeString(`0x${pad('21')}${pad('0')}`)).toThrow(/unaligned/);
    expect(() => decodeString(`0x${pad('40')}`)).toThrow(/truncated/);
    expect(() => decodeString(`0x${pad('20')}${pad('40')}${pad('')}`)).toThrow(/truncated/);
    expect(() => decodeString(`0x${pad('20')}${pad('1')}${'ff'.padEnd(64, '0')}`)).toThrow();
  });
});

describe('diffToken', () => {
  it('passes a matching token, including a differing on-chain symbol and a bridge', () => {
    expect(diffToken(USDC, good(USDC))).toEqual([]);
    expect(diffToken(USDT0, good(USDT0))).toEqual([]);
    expect(diffToken(BASE_UNI, good(BASE_UNI))).toEqual([]);
  });

  it('reports every on-chain difference', () => {
    const o = good(USDC);
    o.onchain = { symbol: 'USDC.e', name: 'Bridged USDC', decimals: 18 };
    expect(diffToken(USDC, o)).toEqual([
      'on-chain symbol "USDC.e", list USDC',
      'on-chain name "Bridged USDC", list USD Coin',
      'on-chain decimals 18, list 6',
    ]);
  });

  it('reports DefiLlama differences, missing entries and low confidence', () => {
    expect(
      diffToken(USDC, { ...good(USDC), llama: { symbol: 'usdc', decimals: 6, confidence: 0.99 } }),
    ).toEqual([]);
    expect(
      diffToken(USDC, { ...good(USDC), llama: { symbol: 'FAKE', decimals: 18, confidence: 0.5 } }),
    ).toEqual([
      'DefiLlama symbol "FAKE", list USDC',
      'DefiLlama decimals 18, list 6',
      'DefiLlama confidence 0.5 < 0.9',
    ]);
    expect(diffToken(USDC, { ...good(USDC), llama: { symbol: 'USDC', decimals: 6 } })).toEqual([
      'DefiLlama confidence undefined < 0.9',
    ]);
    expect(diffToken(USDC, omit(good(USDC), 'llama'))).toEqual(['no DefiLlama entry']);
  });

  it('reports a wrong or unread bridge link', () => {
    const o = good(ARB_UNI);
    o.bridge = { l1Address: '0x0000000000000000000000000000000000000bad', gateway: '0x01' };
    expect(diffToken(ARB_UNI, o)).toEqual([
      `bridge L1 0x0000000000000000000000000000000000000bad, list ${L1_UNI}`,
      `bridge gateway 0x01, list ${ARB_STANDARD_GATEWAY}`,
    ]);
    expect(diffToken(ARB_UNI, omit(good(ARB_UNI), 'bridge'))).toEqual(['bridge link not read']);
  });

  it('never passes a token that could not be read', () => {
    const none = omit(good(USDC), 'onchain');
    expect(diffToken(USDC, none)).toEqual(['no on-chain metadata']);
    expect(diffToken(USDC, { ...none, errors: ['metadata: timeout'] })).toEqual([
      'metadata: timeout',
    ]);
  });
});

/** A fake chain: per (chain, address, selector) results, or a thrown error. */
function fakeDeps(
  results: Record<string, string>,
  coins: Record<string, LlamaCoin>,
  llamaFails = false,
): VerifyDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ethCall: async (chain: ChainKey, to: string, data: string) => {
      const key = `${chain}|${to}|${data}`;
      calls.push(key);
      const r = results[key];
      if (r === undefined) throw new Error(`execution reverted (${data})`);
      return r;
    },
    llama: async () => {
      if (llamaFails) throw new Error('HTTP 502');
      return coins;
    },
  };
}

function chainResults(t: CuratedToken, over: Partial<Record<string, string>> = {}) {
  const k = (sel: string) => `${t.chain}|${t.address}|${sel}`;
  const r: Record<string, string> = {
    [k(SELECTORS.symbol)]: encString(t.onchainSymbol ?? t.symbol),
    [k(SELECTORS.name)]: encString(t.name),
    [k(SELECTORS.decimals)]: encUint(t.decimals),
  };
  if (t.bridge?.kind === 'op-stack') {
    r[k(SELECTORS.remoteToken)] = encAddress(t.bridge.l1Address);
    r[k(SELECTORS.bridge)] = encAddress(t.bridge.gateway);
  }
  if (t.bridge?.kind === 'arbitrum') {
    r[k(SELECTORS.l1Address)] = encAddress(t.bridge.l1Address);
    r[k(SELECTORS.l2Gateway)] = encAddress(t.bridge.gateway);
  }
  for (const [sel, v] of Object.entries(over)) {
    if (v === undefined) Reflect.deleteProperty(r, k(sel));
    else r[k(sel)] = v;
  }
  return r;
}

const coin = (t: CuratedToken): LlamaCoin => ({
  symbol: t.symbol,
  decimals: t.decimals,
  confidence: 0.99,
});

describe('verifyTokens', () => {
  it('passes a consistent list, skips natives and reads bridge links by kind', async () => {
    const deps = fakeDeps(
      { ...chainResults(USDC), ...chainResults(BASE_UNI), ...chainResults(ARB_UNI) },
      {
        [`ethereum:${USDC.address}`]: coin(USDC),
        [`base:${BASE_UNI.address}`]: coin(BASE_UNI),
        [`arbitrum:${ARB_UNI.address}`]: coin(ARB_UNI),
      },
    );
    const reports = await verifyTokens([NATIVE, USDC, BASE_UNI, ARB_UNI], deps);
    expect(reports.map((r) => [r.token.symbol, r.problems])).toEqual([
      ['USDC', []],
      ['UNI', []],
      ['UNI', []],
    ]);
    expect(deps.calls.some((c) => c.endsWith(SELECTORS.remoteToken))).toBe(true);
    expect(deps.calls.some((c) => c.endsWith(SELECTORS.l1Address))).toBe(true);
    expect(deps.calls.some((c) => c.includes('native'))).toBe(false);
  });

  it('reports a decimals mismatch and a reverted call', async () => {
    const deps = fakeDeps(
      {
        ...chainResults(USDC, { [SELECTORS.decimals]: encUint(18) }),
        ...chainResults(ARB_UNI, { [SELECTORS.l2Gateway]: undefined }),
      },
      { [`ethereum:${USDC.address}`]: coin(USDC), [`arbitrum:${ARB_UNI.address}`]: coin(ARB_UNI) },
    );
    const reports = await verifyTokens([USDC, ARB_UNI], deps);
    expect(reports[0]?.problems).toEqual(['on-chain decimals 18, list 6']);
    expect(reports[1]?.problems).toEqual([`bridge: execution reverted (${SELECTORS.l2Gateway})`]);
  });

  it('fails every token when DefiLlama cannot be reached', async () => {
    const deps = fakeDeps(chainResults(USDC), {}, true);
    const [report] = await verifyTokens([USDC], deps);
    expect(report?.problems).toEqual(['DefiLlama: HTTP 502', 'no DefiLlama entry']);
  });
});

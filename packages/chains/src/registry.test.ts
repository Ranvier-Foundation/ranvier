import { describe, expect, it } from 'vitest';
import {
  CHAINS,
  chainFamily,
  getChain,
  isStablecoin,
  isValidAddress,
  isValidTokenAddress,
  isWrappedNative,
  knownDecimals,
} from './registry.js';

describe('chain registry', () => {
  it('finds chains by key', () => {
    expect(getChain('evm:1')?.name).toBe('Ethereum');
    expect(getChain('evm:999999')).toBeUndefined();
  });

  it('matches EVM stablecoins case-insensitively', () => {
    expect(isStablecoin('evm:1', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true);
    expect(isStablecoin('evm:1', '0x0000000000000000000000000000000000000001')).toBe(false);
  });

  it('matches Solana addresses case-sensitively', () => {
    expect(isStablecoin('solana:mainnet', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(
      true,
    );
    expect(isStablecoin('solana:mainnet', 'epjfwdd5aufqssqem2qn1xzybapc8g4wegGkzwytdt1v')).toBe(
      false,
    );
  });

  it('detects wrapped native tokens', () => {
    expect(isWrappedNative('evm:8453', '0x4200000000000000000000000000000000000006')).toBe(true);
    expect(isWrappedNative('evm:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
  });

  it('returns false for unknown chains', () => {
    expect(isStablecoin('evm:5', '0x00')).toBe(false);
    expect(isWrappedNative('evm:5', '0x00')).toBe(false);
  });

  it('records native decimals for every chain', () => {
    expect(getChain('evm:1')?.nativeDecimals).toBe(18);
    expect(getChain('solana:mainnet')?.nativeDecimals).toBe(9);
    for (const chain of CHAINS) {
      expect(chain.nativeDecimals).toBe(chain.family === 'evm' ? 18 : 9);
    }
  });

  it('derives the chain family from the key', () => {
    expect(chainFamily('evm:84532')).toBe('evm');
    expect(chainFamily('solana:mainnet')).toBe('solana');
  });

  it('validates EVM addresses', () => {
    expect(isValidAddress('evm', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true);
    expect(isValidAddress('evm', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb4')).toBe(false);
    expect(isValidAddress('evm', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/../x')).toBe(false);
    expect(isValidAddress('evm', 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800')).toBe(false);
    expect(isValidAddress('evm', 'native')).toBe(false);
  });

  it('validates Solana addresses as 32-44 base58 characters', () => {
    expect(isValidAddress('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isValidAddress('solana', '11111111111111111111111111111111')).toBe(true);
    expect(isValidAddress('solana', '1111111111111111111111111111111')).toBe(false);
    expect(isValidAddress('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v0')).toBe(false);
    expect(isValidAddress('solana', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(false);
  });

  it('accepts native as a token address in both families', () => {
    expect(isValidTokenAddress('evm', 'native')).toBe(true);
    expect(isValidTokenAddress('solana', 'native')).toBe(true);
    expect(isValidTokenAddress('evm', 'NATIVE')).toBe(false);
  });

  it('refuses EVM native placeholders as token addresses', () => {
    expect(isValidTokenAddress('evm', '0x0000000000000000000000000000000000000000')).toBe(false);
    expect(isValidTokenAddress('evm', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')).toBe(false);
    expect(isValidTokenAddress('evm', '0x0000000000000000000000000000000000000001')).toBe(true);
  });

  it('knows decimals for every stablecoin and wrapped native in the registry', () => {
    for (const chain of CHAINS) {
      const listed = [...Object.values(chain.stablecoins), chain.wrappedNative];
      for (const address of listed) {
        expect(knownDecimals(chain.key, address), `${chain.key} ${address}`).toBeTypeOf('number');
      }
      // Chains with a curated token list may know more tokens (ADR 0006, tokens.test.ts).
      if (chain.family === 'solana') {
        expect(Object.keys(chain.knownDecimals).sort()).toEqual([...listed].sort());
      }
    }
  });

  it('looks up known decimals case-insensitively on EVM, and natives from the registry', () => {
    expect(knownDecimals('evm:1', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(6);
    expect(knownDecimals('evm:1', 'native')).toBe(18);
    expect(knownDecimals('solana:mainnet', 'native')).toBe(9);
    expect(knownDecimals('evm:1', '0x0000000000000000000000000000000000000001')).toBeUndefined();
    expect(knownDecimals('evm:5', 'native')).toBeUndefined();
  });
});

describe('CHAINS is immutable at runtime (fee data: stablecoins, knownDecimals)', () => {
  const BASE_WETH = '0x4200000000000000000000000000000000000006';
  const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

  /** Every object reachable from `value`, itself included. */
  function objectsIn(value: object, path: string): [string, object][] {
    const out: [string, object][] = [[path, value]];
    for (const [k, v] of Object.entries(value) as [string, unknown][]) {
      if (typeof v === 'object' && v !== null) out.push(...objectsIn(v, `${path}.${k}`));
    }
    return out;
  }

  it('freezes the array, every chain and every nested object', () => {
    const all = objectsIn(CHAINS, 'CHAINS');
    // The array, four chains, and a stablecoins and knownDecimals map each.
    expect(all.length).toBe(1 + CHAINS.length * 3);
    for (const [path, o] of all) expect(Object.isFrozen(o), path).toBe(true);
  });

  it('throws TypeError on assignment, deletion and addition (ES modules are strict)', () => {
    const base = getChain('evm:8453');
    const eth = getChain('evm:1');
    if (!base || !eth) throw new Error('registry is missing Base or Ethereum');
    const stable = base.stablecoins as Record<string, string>;
    const decimals = eth.knownDecimals as Record<string, number>;
    const attempts: (() => void)[] = [
      () => (stable.WETH = BASE_WETH),
      () => (stable.USDC = BASE_WETH),
      () => delete stable.USDC,
      () => (decimals[ETH_USDC] = 18),
      // The `delete` operator itself is under test (it throws on a frozen object in strict mode).
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      () => delete decimals[ETH_USDC],
      () => (decimals['0x0000000000000000000000000000000000000001'] = 6),
      () => ((base as { stablecoins: Record<string, string> }).stablecoins = { WETH: BASE_WETH }),
      () => ((eth as { nativeDecimals: number }).nativeDecimals = 6),
      () => ((eth as { wrappedNative: string }).wrappedNative = ETH_USDC),
      () => (CHAINS as unknown as unknown[]).push({}),
      () => ((CHAINS as unknown as unknown[])[0] = {}),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(TypeError);
  });

  it('keeps the documented values after failed attempts', () => {
    const stable = getChain('evm:8453')?.stablecoins as Record<string, string>;
    expect(() => (stable.WETH = BASE_WETH)).toThrow(TypeError);
    expect(isStablecoin('evm:8453', BASE_WETH)).toBe(false);
    expect(isStablecoin('evm:8453', BASE_USDC)).toBe(true);
    expect(isWrappedNative('evm:8453', BASE_WETH)).toBe(true);
    expect(knownDecimals('evm:1', ETH_USDC)).toBe(6);
    expect(knownDecimals('evm:1', 'native')).toBe(18);
    expect(Object.keys(getChain('evm:8453')?.stablecoins ?? {}).sort()).toEqual(['DAI', 'USDC']);
  });
});

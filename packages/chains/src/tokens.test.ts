import type { ChainKey } from '@ranvier/types';
import { describe, expect, it } from 'vitest';
import { CHAINS, getChain, isValidTokenAddress, knownDecimals } from './registry.js';
import {
  listedDecimals,
  listTokens,
  MIN_NAME_QUERY_LENGTH,
  searchTokens,
  TOKEN_LIST,
} from './tokens.js';

const LISTED_CHAINS: readonly ChainKey[] = ['evm:1', 'evm:8453', 'evm:42161'];

describe('curated token list: data rules (ADR 0006)', () => {
  it('lists exactly the chains the API quotes today, and not Solana yet', () => {
    expect([...new Set(TOKEN_LIST.map((t) => t.chain))].sort()).toEqual([...LISTED_CHAINS].sort());
    expect(listTokens('solana:mainnet')).toEqual([]);
  });

  it('names only registry chains, with valid lowercase addresses', () => {
    for (const t of TOKEN_LIST) {
      const chain = getChain(t.chain);
      expect(chain, t.chain).toBeDefined();
      if (!chain) continue;
      expect(isValidTokenAddress(chain.family, t.address), t.address).toBe(true);
      if (chain.family === 'evm') expect(t.address).toBe(t.address.toLowerCase());
    }
  });

  it('has unique addresses and unique symbols per chain', () => {
    for (const key of LISTED_CHAINS) {
      const tokens = listTokens(key);
      expect(new Set(tokens.map((t) => t.address)).size, key).toBe(tokens.length);
      expect(new Set(tokens.map((t) => t.symbol.toLowerCase())).size, key).toBe(tokens.length);
    }
  });

  it('has one native entry per chain that matches the registry', () => {
    for (const key of LISTED_CHAINS) {
      const chain = getChain(key);
      const natives = listTokens(key).filter((t) => t.address === 'native');
      expect(natives).toHaveLength(1);
      expect(natives[0]?.symbol).toBe(chain?.nativeSymbol);
      expect(natives[0]?.decimals).toBe(chain?.nativeDecimals);
      expect(natives[0]?.tags).toEqual(['native']);
    }
  });

  it('keeps decimals integral and in range, names and symbols non-empty', () => {
    for (const t of TOKEN_LIST) {
      expect(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36).toBe(true);
      expect(t.symbol.trim()).toBe(t.symbol);
      expect(t.symbol.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it('lists every registry stablecoin and wrapped native, tagged as such', () => {
    for (const key of LISTED_CHAINS) {
      const chain = getChain(key);
      if (!chain) throw new Error(key);
      const byAddress = new Map(listTokens(key).map((t) => [t.address, t]));
      expect(byAddress.get(chain.wrappedNative)?.tags).toContain('wrapped-native');
      for (const address of Object.values(chain.stablecoins)) {
        expect(byAddress.get(address)?.tags, `${key} ${address}`).toContain('stablecoin');
      }
    }
  });
});

describe('decimals are one trusted source (ADR 0004, ADR 0006)', () => {
  it('derives the registry knownDecimals of each listed chain from the token list', () => {
    for (const key of LISTED_CHAINS) {
      expect(getChain(key)?.knownDecimals).toEqual(listedDecimals(key));
    }
  });

  it('gives every listed token, in any case, the same knownDecimals', () => {
    for (const t of TOKEN_LIST) {
      expect(knownDecimals(t.chain, t.address)).toBe(t.decimals);
      expect(knownDecimals(t.chain, t.address.toUpperCase().replace('0X', '0x'))).toBe(
        t.address === 'native' ? undefined : t.decimals,
      );
    }
  });

  it('pins the decimals of the core tokens', () => {
    expect(knownDecimals('evm:1', '0xdac17f958d2ee523a2206206994597c13d831ec7')).toBe(6);
    expect(knownDecimals('evm:1', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599')).toBe(8);
    expect(knownDecimals('evm:42161', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9')).toBe(6);
    expect(knownDecimals('evm:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(6);
  });

  it('has no entry for unlisted chains', () => {
    expect(listedDecimals('evm:5')).toEqual({});
    for (const chain of CHAINS) {
      if (!LISTED_CHAINS.includes(chain.key)) expect(listTokens(chain.key)).toEqual([]);
    }
  });
});

describe('listTokens', () => {
  it('orders natives, then stablecoins, then the rest, each by symbol', () => {
    expect(listTokens('evm:1').map((t) => t.symbol)).toEqual([
      'ETH',
      'DAI',
      'USDC',
      'USDT',
      'AAVE',
      'LINK',
      'UNI',
      'WBTC',
      'WETH',
    ]);
    expect(listTokens('evm:42161').map((t) => t.symbol)).toEqual([
      'ETH',
      'DAI',
      'USDC',
      'USDT0',
      'ARB',
      'LINK',
      'UNI',
      'WBTC',
      'WETH',
    ]);
  });

  it('does not reorder the shared list', () => {
    const before = TOKEN_LIST.map((t) => `${t.chain}:${t.address}`);
    listTokens('evm:8453');
    expect(TOKEN_LIST.map((t) => `${t.chain}:${t.address}`)).toEqual(before);
  });
});

describe('searchTokens', () => {
  const symbols = (chain: ChainKey, q: string, limit = 100) =>
    searchTokens(chain, q, limit).map((t) => t.symbol);

  it('returns everything for an empty or blank query', () => {
    expect(symbols('evm:1', '')).toHaveLength(listTokens('evm:1').length);
    expect(symbols('evm:1', '   ')).toHaveLength(listTokens('evm:1').length);
  });

  it('matches symbols case-insensitively by substring, in display order', () => {
    expect(symbols('evm:1', 'usd')).toEqual(['USDC', 'USDT']);
    expect(symbols('evm:1', 'WeTh')).toEqual(['WETH']);
    expect(symbols('evm:42161', 'usdt')).toEqual(['USDT0']);
  });

  it('matches names case-insensitively from the minimum length', () => {
    expect(MIN_NAME_QUERY_LENGTH).toBe(2);
    expect(symbols('evm:1', 'wrapped')).toEqual(['WBTC', 'WETH']);
    expect(symbols('evm:1', 'CHAINlink')).toEqual(['LINK']);
    // One character matches symbols only: "o" is in several names but in no symbol.
    expect(symbols('evm:1', 'o')).toEqual([]);
    expect(symbols('evm:1', 'to')).toEqual(['AAVE', 'LINK']);
  });

  it('matches a full address exactly, in any case, and partial addresses never', () => {
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    expect(symbols('evm:1', usdc.toUpperCase().replace('0X', '0x'))).toEqual(['USDC']);
    expect(symbols('evm:1', ` ${usdc} `)).toEqual(['USDC']);
    expect(symbols('evm:1', usdc.slice(0, 10))).toEqual([]);
    expect(symbols('evm:8453', usdc)).toEqual([]);
  });

  it('applies the limit after ordering', () => {
    expect(symbols('evm:1', '', 3)).toEqual(['ETH', 'DAI', 'USDC']);
    expect(symbols('evm:1', '', 0)).toEqual([]);
    expect(symbols('evm:1', '', -1)).toEqual([]);
  });

  it('returns nothing for a chain without a list', () => {
    expect(symbols('solana:mainnet', '')).toEqual([]);
  });
});

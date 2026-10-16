import type { ChainKey, TokenTag } from '@ranvier/types';
import { describe, expect, it } from 'vitest';
import { CHAINS, getChain, isStablecoin, isValidTokenAddress, knownDecimals } from './registry.js';
import {
  ARB_STANDARD_GATEWAY,
  ARB_DAI_GATEWAY,
  ARB_WETH_GATEWAY,
  type CuratedToken,
  displayOrder,
  searchTokenList,
  OP_STANDARD_BRIDGE,
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

describe('display and fees agree: stablecoin tag == registry stablecoins', () => {
  it('tags exactly the registry stablecoins of each listed chain, keyed by symbol', () => {
    for (const key of LISTED_CHAINS) {
      const chain = getChain(key);
      if (!chain) throw new Error(key);
      const tagged = Object.fromEntries(
        listTokens(key)
          .filter((t) => t.tags?.includes('stablecoin'))
          .map((t) => [t.symbol, t.address]),
      );
      expect(tagged, key).toEqual(chain.stablecoins);
    }
  });

  it('pins the stablecoin allowlist per chain (spec section 2: USDC, USDT, DAI)', () => {
    const symbolsOf = (key: ChainKey) => Object.keys(getChain(key)?.stablecoins ?? {}).sort();
    expect(symbolsOf('evm:1')).toEqual(['DAI', 'USDC', 'USDT']);
    expect(symbolsOf('evm:8453')).toEqual(['DAI', 'USDC']);
    expect(symbolsOf('evm:42161')).toEqual(['DAI', 'USDC', 'USDT0']);
    expect(isStablecoin('evm:8453', '0x50C5725949A6F0c72E6C4a641F24049A917DB0Cb')).toBe(true);
    expect(isStablecoin('evm:42161', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9')).toBe(true);
    expect(isStablecoin('evm:42161', '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1')).toBe(true);
    // cbBTC is listed but is not a stablecoin.
    expect(isStablecoin('evm:8453', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf')).toBe(false);
  });
});

describe('TOKEN_LIST is immutable at runtime', () => {
  it('freezes the list, every entry and every nested object', () => {
    expect(Object.isFrozen(TOKEN_LIST)).toBe(true);
    for (const t of TOKEN_LIST) {
      expect(Object.isFrozen(t)).toBe(true);
      if (t.tags) expect(Object.isFrozen(t.tags)).toBe(true);
      if (t.bridge) expect(Object.isFrozen(t.bridge)).toBe(true);
    }
  });

  it('throws on mutation (ES modules are strict) and keeps the values', () => {
    const usdc = TOKEN_LIST.find((t) => t.chain === 'evm:1' && t.symbol === 'USDC');
    if (!usdc) throw new Error('no USDC');
    expect(() => {
      (usdc as { decimals: number }).decimals = 18;
    }).toThrow(TypeError);
    expect(() => {
      (TOKEN_LIST as CuratedToken[]).push({ ...usdc, symbol: 'FAKE' });
    }).toThrow(TypeError);
    expect(() => {
      (usdc.tags as TokenTag[]).push('native');
    }).toThrow(TypeError);
    expect(usdc.decimals).toBe(6);
    expect(knownDecimals('evm:1', usdc.address)).toBe(6);
  });
});

describe('cbBTC (owner decision: issuer-controlled core asset)', () => {
  it('is listed on Ethereum, Base and Arbitrum One at one address with 8 decimals', () => {
    for (const key of LISTED_CHAINS) {
      expect(
        listTokens(key).find((t) => t.symbol === 'cbBTC'),
        key,
      ).toMatchObject({
        address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
        name: 'Coinbase Wrapped BTC',
        decimals: 8,
      });
      expect(knownDecimals(key, '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf')).toBe(8);
    }
  });
});

describe('bridge links', () => {
  it('declare lowercase L1 addresses that are listed on Ethereum, and known gateways', () => {
    const l1 = new Set(listTokens('evm:1').map((t) => t.address));
    const bridged = TOKEN_LIST.filter((t) => t.bridge);
    expect(bridged.length).toBeGreaterThan(0);
    for (const t of bridged) {
      const b = t.bridge;
      if (!b) continue;
      expect(l1.has(b.l1Address), `${t.chain} ${t.symbol}`).toBe(true);
      expect(b.kind).toBe(t.chain === 'evm:8453' ? 'op-stack' : 'arbitrum');
      expect([OP_STANDARD_BRIDGE, ARB_STANDARD_GATEWAY, ARB_WETH_GATEWAY]).toContain(b.gateway);
    }
  });
  it('give every bridged-tagged token a checkable link or a written, checkable exemption', () => {
    const bridged = TOKEN_LIST.filter((t) => t.tags?.includes('bridged'));
    expect(bridged.length).toBeGreaterThan(0);
    for (const t of bridged) {
      const label = `${t.chain} ${t.symbol}`;
      // Exactly one of the two: a link verify:tokens checks, or an exemption with a reason.
      expect(Boolean(t.bridge) !== Boolean(t.bridgeExemption), label).toBe(true);
      if (t.bridgeExemption) {
        expect(t.bridgeExemption.reason.trim().length, label).toBeGreaterThan(20);
        expect(t.bridgeExemption.ward, label).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
    // Exemptions only make sense on bridged tokens.
    for (const t of TOKEN_LIST.filter((x) => x.bridgeExemption)) {
      expect(t.tags, `${t.chain} ${t.symbol}`).toContain('bridged');
    }
  });

  it("exempts Arbitrum DAI: Maker's Dai gateway is a ward, not a standard gateway", () => {
    const dai = TOKEN_LIST.find((t) => t.chain === 'evm:42161' && t.symbol === 'DAI');
    expect(dai?.bridge).toBeUndefined();
    expect(dai?.bridgeExemption?.ward).toBe(ARB_DAI_GATEWAY);
    expect(ARB_DAI_GATEWAY).toBe('0x467194771dae2967aef3ecbedd3bf9a310c76c65');
    expect(Object.isFrozen(dai?.bridgeExemption)).toBe(true);
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
  it('orders natives, then stablecoins, then the rest, each by case-insensitive symbol', () => {
    expect(listTokens('evm:1').map((t) => t.symbol)).toEqual([
      'ETH',
      'DAI',
      'USDC',
      'USDT',
      'AAVE',
      'cbBTC',
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
      'cbBTC',
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
    expect(symbols('evm:1', 'wrapped')).toEqual(['cbBTC', 'WBTC', 'WETH']);
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

describe('displayOrder and searchTokenList (lists kept outside TOKEN_LIST)', () => {
  it('displayOrder is the listTokens order, on a copy', () => {
    for (const chain of ['evm:1', 'evm:8453', 'evm:42161'] as const) {
      const list = TOKEN_LIST.filter((t) => t.chain === chain);
      const shuffled = [...list].reverse();
      expect(displayOrder(shuffled)).toEqual(listTokens(chain));
      expect(shuffled).toEqual([...list].reverse());
    }
  });

  it('searchTokenList over a chain list equals searchTokens', () => {
    for (const chain of ['evm:1', 'evm:8453', 'evm:42161'] as const) {
      for (const q of [
        '',
        'us',
        'USDC',
        'e',
        'wrapped',
        '0x12',
        listTokens(chain)[1]?.address ?? '',
      ]) {
        for (const limit of [0, 1, 50]) {
          expect(searchTokenList(listTokens(chain), q, limit)).toEqual(
            searchTokens(chain, q, limit),
          );
        }
      }
    }
  });
});

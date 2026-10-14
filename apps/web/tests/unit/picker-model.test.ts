import { describe, expect, it } from 'vitest';
import type { ApiChain, ApiToken } from '../../src/lib/api/schemas';
import { formatTokenAmount } from '../../src/lib/format';
import {
  buildRows,
  quickPicks,
  splitSections,
  type ChainBalances,
} from '../../src/lib/picker/model';
import { MAX_QUERY_LENGTH, normaliseQuery } from '../../src/lib/picker/search';
import { balanceText } from '../../src/components/token-row';

const base: ApiChain = {
  key: 'evm:8453',
  name: 'Base',
  family: 'evm',
  nativeSymbol: 'ETH',
  balances: true,
};
const eth: ApiChain = {
  key: 'evm:1',
  name: 'Ethereum',
  family: 'evm',
  nativeSymbol: 'ETH',
  balances: true,
};
const tok = (
  chain: ApiChain,
  symbol: string,
  address: string,
  decimals: number,
  tags: ApiToken['tags'] = [],
): ApiToken => ({
  chain: chain.key,
  address,
  symbol,
  name: symbol,
  decimals,
  tags,
});
const NATIVE = tok(base, 'ETH', 'native', 18, ['native']);
const USDC = tok(base, 'USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6, ['stablecoin']);
const AERO = tok(base, 'AERO', '0x940181a94a35a4569e4529a3cdfb74e38fd98631', 18);
const WALLET = '0x7a3e1b2c9d4f5a60718293a4b5c6d7e8f9013f9c';

describe('formatTokenAmount', () => {
  it.each([
    [0n, 18, undefined, '0'],
    [84_100_000_000_000_000n, 18, undefined, '0.0841'],
    [3_200_000_000_000_000_000n, 18, undefined, '3.2'],
    [1_200_000n * 10n ** 18n, 18, undefined, '1,200,000'],
    [2_410_500_000n, 6, { fixed: 2 }, '2,410.50'],
    [640_000_000n, 6, { fixed: 2 }, '640.00'],
    [0n, 6, { fixed: 2 }, '0.00'],
    [5n, 0, undefined, '5'],
    [5n, 0, { fixed: 2 }, '5.00'],
    // Truncates, never rounds up.
    [1_999_999_999_999_999_999n, 18, undefined, '1.9999'],
    [999_999n, 6, { fixed: 2 }, '0.99'],
    // Non-zero but below the places shown.
    [1n, 18, undefined, '<0.0001'],
    [9_999_999_999_999n, 18, undefined, '<0.0001'],
    [9_999n, 6, { fixed: 2 }, '<0.01'],
    // Beyond 2^53 stays exact.
    [
      2n ** 256n - 1n,
      18,
      undefined,
      `${((2n ** 256n - 1n) / 10n ** 18n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.1584`,
    ],
  ] as const)('%s with %s decimals %j -> %s', (amount, decimals, opts, text) => {
    expect(formatTokenAmount(amount, decimals, opts)).toBe(text);
  });
  it('refuses a negative amount', () => {
    expect(() => formatTokenAmount(-1n, 18)).toThrow(RangeError);
  });
});

describe('normaliseQuery', () => {
  it('trims and accepts names, symbols and addresses', () => {
    expect(normaliseQuery('  usdc ')).toEqual({ query: 'usdc', searchable: true });
    expect(normaliseQuery('USD Coin')).toEqual({ query: 'USD Coin', searchable: true });
    expect(normaliseQuery('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913').searchable).toBe(true);
    expect(normaliseQuery('₮ether').searchable).toBe(true);
    expect(normaliseQuery('').searchable).toBe(true);
  });
  it.each(['<script>', 'a/b', 'q=1&x', 'usdc%00', 'a\nb', 'x'.repeat(MAX_QUERY_LENGTH + 1)])(
    'will not send %j',
    (raw) => {
      expect(normaliseQuery(raw).searchable).toBe(false);
    },
  );
});

describe('rows and sections', () => {
  const ready = (byAddress: Record<string, bigint | null>): ChainBalances => ({
    status: 'ready',
    byAddress: new Map(Object.entries(byAddress)),
  });
  const tokens = [NATIVE, USDC, AERO];

  it('shows no balance without a wallet', () => {
    const rows = buildRows(tokens, [base], new Map(), undefined);
    expect(rows.every((r) => r.balance.state === 'unknown')).toBe(true);
    expect(splitSections(rows)).toMatchObject({ held: [], other: expect.any(Array) });
  });
  it('shows a placeholder until the chain answers', () => {
    const rows = buildRows(tokens, [base], new Map([['evm:8453', { status: 'loading' }]]), WALLET);
    expect(rows.map((r) => r.balance.state)).toEqual(['loading', 'loading', 'loading']);
    expect(buildRows(tokens, [base], new Map(), WALLET)[0]?.balance.state).toBe('loading');
  });
  it('puts held tokens first, keeps list order, and a failed balance never hides a token', () => {
    const balances = new Map<'evm:8453', ChainBalances>([
      ['evm:8453', ready({ native: 5n, [USDC.address]: 0n, [AERO.address]: null })],
    ]);
    const { held, other } = splitSections(buildRows(tokens, [base], balances, WALLET));
    expect(held.map((r) => r.token.symbol)).toEqual(['ETH']);
    expect(other.map((r) => r.token.symbol)).toEqual(['USDC', 'AERO']);
  });
  it('treats an errored or unavailable chain as unknown, with every token still listed', () => {
    for (const status of ['error', 'unavailable'] as const) {
      const rows = buildRows(tokens, [base], new Map([['evm:8453', { status }]]), WALLET);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.balance.state === 'unknown')).toBe(true);
    }
  });
  it('drops a token whose chain the API did not list, and keys rows by chain and address', () => {
    const other = tok(eth, 'ETH', 'native', 18, ['native']);
    const rows = buildRows([NATIVE, other], [base], new Map(), undefined);
    expect(rows.map((r) => r.key)).toEqual(['evm:8453:native']);
  });
  it('shows a balance for a stablecoin with two places and hides zero', () => {
    const balances = new Map<'evm:8453', ChainBalances>([
      ['evm:8453', ready({ native: 0n, [USDC.address]: 640_000_000n })],
    ]);
    const rows = buildRows(tokens, [base], balances, WALLET);
    expect(rows.map(balanceText)).toEqual([undefined, '640.00', undefined]);
  });
  it('quick picks are the native coin and the stablecoins the API tagged', () => {
    expect(quickPicks(tokens).map((t) => t.symbol)).toEqual(['ETH', 'USDC']);
  });
});

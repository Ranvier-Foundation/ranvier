import { TOKEN_LIST } from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import { describe, expect, it } from 'vitest';
import { SchemaError, parseTokens } from '../../src/lib/api/schemas';

const BASE = 'evm:8453';
const ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const OTHER = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';

const token = (over: Record<string, unknown> = {}) => ({
  chain: BASE,
  address: ADDRESS,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  tags: [],
  ...over,
});

const parse = (over: Record<string, unknown>) => parseTokens([token(over)], BASE);

describe('every token in the verified list passes the web validators', () => {
  const chains = [...new Set(TOKEN_LIST.map((t) => t.chain))];
  it('lists tokens for at least one chain', () => {
    expect(chains.length).toBeGreaterThan(0);
  });
  it.each(chains)('chain %s', (chain) => {
    const entries = TOKEN_LIST.filter((t) => t.chain === chain);
    // The API sends the public fields only, and an empty `tags` for an untagged token.
    const parsed = parseTokens(
      entries.map((t) => ({ ...t, tags: t.tags ?? [] })),
      chain as ChainKey,
    );
    expect(parsed.map((t) => [t.symbol, t.name])).toEqual(entries.map((t) => [t.symbol, t.name]));
  });
});

describe('token symbols', () => {
  it.each(['USDC', 'cbBTC', 'USDT0', 'stETH', 'A.B', 'x+y', 'a-b', 'A'.repeat(32)])(
    'accepts %s',
    (symbol) => {
      expect(parse({ symbol })[0]?.symbol).toBe(symbol);
    },
  );
  it.each([
    ['Cyrillic С in USDС', 'USDС'],
    ['Greek Ο in USDΟ', 'USDΟ'],
    ['fullwidth ＵＳＤＣ', 'ＵＳＤＣ'],
    ['mathematical bold 𝐔𝐒𝐃𝐂', '\u{1D414}\u{1D412}\u{1D403}\u{1D402}'],
    ['Hangul filler U+3164', 'USDㅤ'],
    ['braille blank U+2800', 'USD⠀'],
    ['30 stacked combining marks', `U${'́'.repeat(30)}`],
    ['no-break space', 'US DC'],
    ['an ordinary space', 'US DC'],
    ['an ideographic space', 'US　DC'],
    ['a zero-width space', 'US​DC'],
    ['an emoji', 'USD\u{1F4B0}'],
    ['a slash', 'USD/C'],
    ['markup', '<b>'],
    ['empty', ''],
    ['33 characters', 'A'.repeat(33)],
    ['a number', 5],
  ])('refuses %s', (_label, symbol) => {
    expect(() => parse({ symbol })).toThrow(SchemaError);
  });
});

describe('token names', () => {
  it.each([
    'USD Coin',
    'USD₮0',
    'Wrapped Ether',
    'Ünï Token',
    'Токен',
    'Ελληνικό',
    '日本円 コイン',
    'שקל',
    'Coin (v2) - the 1st & best, 100% real: a/b + c_d',
    '<img src=x onerror=alert(1)>',
  ])('accepts %j', (name) => {
    expect(parse({ name })[0]?.name).toBe(name);
  });
  it.each([
    ['an acute accent', 'Etheŕ'],
    ['30 stacked combining marks', `Ether${'́'.repeat(30)}`],
    ['a combining mark after a space', 'Ether ́'],
    ['Hangul filler U+3164', 'WrappedㅤEther'],
    ['Hangul filler U+115F', 'WrappedᅟEther'],
    ['halfwidth Hangul filler U+FFA0', 'WrappedﾠEther'],
    ['braille blank U+2800', 'Wrapped⠀Ether'],
    ['a blank-only name made of fillers', 'ㅤㅤ'],
    ['mixed Latin and Cyrillic (С)', 'USD Сoin'],
    ['mixed Latin and Greek (Ο)', 'USD CΟin'],
    ['mixed Cyrillic and Han', 'Токен 日本'],
    ['fullwidth letters', 'ＵＳＤ Coin'],
    ['mathematical bold letters', '\u{1D414}\u{1D412}\u{1D403} Coin'],
    ['a ligature', 'ﬁnance'],
    ['a click letter (Latin Extended-B)', 'Aaǀe'],
    ['an IPA letter', 'ɑave'],
    ['no-break space', 'USD Coin'],
    ['ideographic space', 'USD　Coin'],
    ['thin space', 'USD Coin'],
    ['two spaces', 'USD  Coin'],
    ['an Arabic-Indic digit', 'Coin ٣'],
    ['an emoji', 'Coin \u{1F680}'],
    ['a zero-width space (existing rule)', 'US​D Coin'],
    ['a right-to-left override (existing rule)', 'USD‮Coin'],
    ['a line separator (existing rule)', 'USD Coin'],
    ['padding (existing rule)', ' USD Coin'],
    ['more than 64 characters', 'a'.repeat(65)],
  ])('refuses %s', (_label, name) => {
    expect(() => parse({ name })).toThrow(SchemaError);
  });
});

describe('duplicate symbols on one chain', () => {
  it('refuses two tokens with one symbol in one answer', () => {
    expect(() => parseTokens([token(), token({ address: OTHER })], BASE)).toThrow(SchemaError);
  });
  it('compares without case', () => {
    expect(() => parseTokens([token(), token({ address: OTHER, symbol: 'usdc' })], BASE)).toThrow(
      SchemaError,
    );
  });
  it('accepts the same symbol on different chains and different symbols on one', () => {
    expect(parseTokens([token(), token({ address: OTHER, symbol: 'USDT' })], BASE)).toHaveLength(2);
    expect(parseTokens([token({ chain: 'evm:1' })], 'evm:1')).toHaveLength(1);
  });
});

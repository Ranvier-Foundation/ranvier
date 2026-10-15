import { describe, expect, it } from 'vitest';
import {
  MAX_UINT256,
  cleanAmountText,
  fitToDecimals,
  formatUnitsExact,
  parseAmount,
} from '../../src/lib/swap/amount';
import { MAX_AMOUNT_CHARS } from '../../src/lib/swap/config';
import { formatRate, unitRate, usdPerToken } from '../../src/lib/swap/rate';

/** A small deterministic generator, so the property-style cases below are the same on every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ok = (text: string, decimals: number) => {
  const r = parseAmount(text, decimals);
  if (r.kind !== 'ok') throw new Error(`${text} (${decimals}) is ${r.kind}`);
  return r.units;
};

describe('parseAmount: exact string maths', () => {
  it.each([
    ['1', 18, 10n ** 18n],
    ['0.5', 18, 5n * 10n ** 17n],
    ['.5', 18, 5n * 10n ** 17n],
    ['5.', 6, 5_000_000n],
    ['0.000001', 6, 1n],
    ['123.456789', 6, 123_456_789n],
    ['1000', 0, 1000n],
    ['00012', 0, 12n],
    ['0.1', 1, 1n],
    ['1,000', 18, 1000n * 10n ** 18n],
    ['1,234,567.5', 6, 1_234_567_500_000n],
    ['  7  ', 2, 700n],
  ])('%s with %i decimals is %s base units', (text, decimals, units) => {
    expect(ok(text, decimals)).toBe(units);
  });

  it('never loses a digit that a float would: 0.1 + 0.2 sized inputs, 18 decimals, 2^53 and beyond', () => {
    expect(ok('0.3', 18)).toBe(300_000_000_000_000_000n);
    expect(ok('9007199254740993', 0)).toBe(9007199254740993n); // 2^53 + 1
    expect(ok('9007199254740993.000000000000000001', 18)).toBe(9007199254740993_000000000000000001n);
    expect(ok('0.123456789012345678', 18)).toBe(123456789012345678n);
  });

  it('empty and zero are not amounts', () => {
    for (const t of ['', '   ', '.']) expect(parseAmount(t, 18).kind).toBe('empty');
    for (const t of ['0', '0.0', '000', '.000', '0.000000000000000000']) {
      expect(parseAmount(t, 18).kind).toBe('zero');
    }
  });

  it('refuses excess precision, signs, exponents, letters, other scripts, spaces inside', () => {
    const bad: [string, number][] = [
      ['0.1234567', 6], // 7 places for a 6 decimal token
      ['1.5', 0], // a whole-number token takes no decimal point
      ['5.', 0],
      ['-1', 18],
      ['+1', 18],
      ['1e18', 18],
      ['1E3', 18],
      ['0x10', 18],
      ['abc', 18],
      ['1.2.3', 18],
      ['1 000', 18],
      ['١٢٣', 18], // Arabic-Indic digits
      ['１２３', 18], // fullwidth digits
      ['1,5', 18], // not a thousands group
      ['1,00', 18],
      ['1,0000', 18],
      [',100', 18],
      ['1,000,00', 18],
      ['1_000', 18],
      ['NaN', 18],
      ['Infinity', 18],
      ['1 000', 18],
    ];
    for (const [text, decimals] of bad) {
      expect(parseAmount(text, decimals).kind, text).toBe('invalid');
      expect(cleanAmountText(text, decimals), text).toBeNull();
    }
  });

  it('clamps absurd lengths before doing any maths', () => {
    expect(cleanAmountText('1'.repeat(MAX_AMOUNT_CHARS), 18)).not.toBeNull();
    expect(cleanAmountText('1'.repeat(MAX_AMOUNT_CHARS + 1), 18)).toBeNull();
    expect(cleanAmountText('0.' + '0'.repeat(5000), 18)).toBeNull();
  });

  it('huge values: the largest uint256 is the limit', () => {
    expect(ok(MAX_UINT256.toString(), 0)).toBe(MAX_UINT256);
    expect(parseAmount((MAX_UINT256 + 1n).toString(), 0).kind).toBe('too_large');
    expect(parseAmount('9'.repeat(78), 18).kind).toBe('too_large');
    // 1.157...e77 base units at 18 decimals is 1.157e59 whole tokens.
    expect(parseAmount('115792089237316195423570985008687907853269984665640564039457', 18).kind).toBe(
      'ok',
    );
    expect(parseAmount('115792089237316195423570985008687907853269984665640564039458', 18).kind).toBe(
      'too_large',
    );
  });
});

describe('formatUnitsExact and parseAmount round-trip', () => {
  it('prints every digit, trims trailing zeros, keeps no grouping', () => {
    expect(formatUnitsExact(0n, 18)).toBe('0');
    expect(formatUnitsExact(1n, 18)).toBe('0.000000000000000001');
    expect(formatUnitsExact(10n ** 18n, 18)).toBe('1');
    expect(formatUnitsExact(1_500_000n, 6)).toBe('1.5');
    expect(formatUnitsExact(123456789n, 0)).toBe('123456789');
    expect(formatUnitsExact(MAX_UINT256, 18)).toBe(
      '115792089237316195423570985008687907853269984665640564039457.584007913129639935',
    );
    expect(() => formatUnitsExact(-1n, 18)).toThrow(RangeError);
    expect(() => formatUnitsExact(1n, -1)).toThrow(RangeError);
  });

  it('round-trips 20,000 random amounts at every decimals from 0 to 36, and the edges', () => {
    const rnd = lcg(12345);
    const edges = (d: number): bigint[] => [
      1n,
      2n,
      10n ** BigInt(d) - 1n,
      10n ** BigInt(d),
      10n ** BigInt(d) + 1n,
      MAX_UINT256,
      MAX_UINT256 - 1n,
    ];
    let count = 0;
    for (let d = 0; d <= 36; d++) {
      const values = edges(d);
      for (let i = 0; i < 540; i++) {
        const digits = 1 + Math.floor(rnd() * 77);
        let s = '';
        for (let k = 0; k < digits; k++) s += Math.floor(rnd() * 10).toString();
        values.push(BigInt(s) % (MAX_UINT256 + 1n));
      }
      for (const units of values) {
        if (units === 0n) continue;
        const text = formatUnitsExact(units, d);
        if (text.length > MAX_AMOUNT_CHARS) continue; // the field would not take it
        expect(ok(text, d), `${units} at ${d}`).toBe(units);
        count++;
      }
    }
    expect(count).toBeGreaterThan(19_000);
  });

  it('typed text survives parse then format, apart from padding and grouping', () => {
    const rnd = lcg(99);
    for (let i = 0; i < 2_000; i++) {
      const d = Math.floor(rnd() * 19);
      const whole = String(Math.floor(rnd() * 1e9));
      const fractionDigits = Math.floor(rnd() * (d + 1));
      let fraction = '';
      for (let k = 0; k < fractionDigits; k++) fraction += Math.floor(rnd() * 10).toString();
      const text = fraction === '' || d === 0 ? whole : `${whole}.${fraction}`;
      const units = parseAmount(text, d);
      if (units.kind === 'zero') continue;
      expect(units.kind).toBe('ok');
      if (units.kind !== 'ok') continue;
      const expected = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
      expect(formatUnitsExact(units.units, d)).toBe(expected.replace(/^0+(?=\d)/, ''));
    }
  });
});

describe('fitToDecimals: a token change cuts, never rounds', () => {
  it.each([
    ['0.123456789', 6, '0.123456'],
    ['0.999999999', 2, '0.99'],
    ['12.5', 0, '12'],
    ['12', 0, '12'],
    ['0.5', 18, '0.5'],
    ['.5', 0, ''],
    ['7.', 0, '7'],
  ])('%s at %i decimals is %s', (text, decimals, expected) => {
    expect(fitToDecimals(text, decimals)).toBe(expected);
  });
});

describe('rates from bigint amounts', () => {
  it('unitRate: how many numerator units one whole denominator token costs', () => {
    // 124.75 USDC for 0.0499 ETH.
    const usdc = 124_750_000n;
    const eth = 49_900_000_000_000_000n;
    expect(unitRate(usdc, eth, 18)).toBe(2_500_000_000n); // 2,500 USDC per ETH
    expect(unitRate(eth, usdc, 6)).toBe(400_000_000_000_000n); // 0.0004 ETH per USDC
    expect(unitRate(1n, 0n, 18)).toBeUndefined();
    expect(unitRate(-1n, 5n, 18)).toBeUndefined();
  });

  it('formatRate: grouped from 1 up, four significant digits below, truncated', () => {
    expect(formatRate(2_489_080_000n, 6)).toBe('2,489.08');
    expect(formatRate(1_000_000n, 6)).toBe('1');
    expect(formatRate(400_800_000_000_000n, 18)).toBe('0.0004008');
    expect(formatRate(401_755_999_999_999n, 18)).toBe('0.0004017');
    expect(formatRate(1n, 18)).toBe('0.000000000000000001');
    expect(formatRate(0n, 18)).toBe('0');
    expect(formatRate(999_999n, 6)).toBe('0.9999');
    expect(formatRate(5n, 0)).toBe('5');
  });

  it('usdPerToken: the value of one whole token in dollars, from integer cents', () => {
    expect(usdPerToken(12_475n, 49_900_000_000_000_000n, 18)).toBe('$2,500.00');
    expect(usdPerToken(12_475n, 0n, 18)).toBeUndefined();
  });
});

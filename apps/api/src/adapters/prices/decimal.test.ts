import { describe, expect, it } from 'vitest';
import { parseDecimalScaled } from './decimal.js';

describe('parseDecimalScaled', () => {
  it('converts plain and fractional decimals exactly', () => {
    expect(parseDecimalScaled('1', 18)).toBe(10n ** 18n);
    expect(parseDecimalScaled('0.9997288492928289', 18)).toBe(999_728_849_292_828_900n);
    expect(parseDecimalScaled('2547.3065189057347', 18)).toBe(2_547_306_518_905_734_700_000n);
    expect(parseDecimalScaled('0.00000042', 18)).toBe(420_000_000_000n);
  });

  it('handles exponents', () => {
    expect(parseDecimalScaled('1e-7', 18)).toBe(100_000_000_000n);
    expect(parseDecimalScaled('4.2e-7', 18)).toBe(420_000_000_000n);
    expect(parseDecimalScaled('1E+21', 18)).toBe(10n ** 39n);
    expect(parseDecimalScaled('1.5e3', 0)).toBe(1_500n);
  });

  it('rounds down below the scale', () => {
    expect(parseDecimalScaled('1e-19', 18)).toBe(0n);
    expect(parseDecimalScaled('0.1234567890123456789', 18)).toBe(123_456_789_012_345_678n);
  });

  it('keeps the sign so callers can reject negatives', () => {
    expect(parseDecimalScaled('-1.5', 1)).toBe(-15n);
    expect(parseDecimalScaled('0', 18)).toBe(0n);
  });

  it('rejects anything that is not a JSON number', () => {
    for (const bad of ['', 'NaN', 'Infinity', '1.', '.5', '01', '0x10', '1e', '1,5', ' 1']) {
      expect(() => parseDecimalScaled(bad, 18), bad).toThrow(RangeError);
    }
    expect(() => parseDecimalScaled('1e999', 18)).toThrow('exponent out of range');
  });
});

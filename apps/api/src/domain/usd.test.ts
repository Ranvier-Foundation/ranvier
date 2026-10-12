import { describe, expect, it } from 'vitest';
import { usdCents, usdE18 } from './usd.js';

const E18 = 10n ** 18n;

describe('USD conversion', () => {
  it('converts base units to cents and attoUSD, rounding down', () => {
    const usdc = { decimals: 6, usdE18: 999_800_000_000_000_000n }; // $0.9998
    expect(usdCents(usdc, 1_000n * 10n ** 6n)).toBe(99_980n);
    expect(usdCents(usdc, 1n)).toBe(0n);
    expect(usdE18(usdc, 1n)).toBe(999_800_000_000n);
  });

  it('handles tiny and very large prices exactly', () => {
    const shib = { decimals: 18, usdE18: 420_000_000_000n }; // $0.00000042
    expect(usdCents(shib, 1_000_000n * E18)).toBe(42n);
    const btc = { decimals: 8, usdE18: 1_000_000_000n * E18 }; // $1bn per token
    expect(usdCents(btc, 10n ** 8n)).toBe(100_000_000_000n);
  });

  it('rejects negative amounts', () => {
    const p = { decimals: 0, usdE18: E18 };
    expect(() => usdCents(p, -1n)).toThrow(RangeError);
    expect(() => usdE18(p, -1n)).toThrow(RangeError);
  });
});

import { describe, expect, it } from 'vitest';
import { quoteFee } from '@ranvier/fees';
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

describe('tier boundaries with cent flooring', () => {
  // A token at exactly $1 with 18 decimals: 1 cent = 10^16 base units.
  const price = { decimals: 18, usdE18: E18 };
  const ETH = { chain: 'evm:1' as const, address: 'native' };
  const USDC = { chain: 'evm:1' as const, address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' };
  const bpsFor = (amount: bigint, isFirstSwap = false) =>
    quoteFee({
      sellToken: ETH,
      buyToken: USDC,
      sellAmount: amount,
      usdValue: usdCents(price, amount),
      isFirstSwap,
    });
  const usd = (dollars: bigint) => dollars * E18;
  const SUB_CENT = 10n ** 16n - 1n;

  it('never gives a cheaper tier than the exact value deserves', () => {
    // Just under $10,000 stays at 20 bps; exactly $10,000 is 15 bps.
    expect(bpsFor(usd(10_000n) - 1n).bps).toBe(20);
    expect(bpsFor(usd(10_000n)).bps).toBe(15);
    // Above $100,000 by under one cent floors to $100,000.00: the dearer 15 bps tier.
    expect(bpsFor(usd(100_000n) + SUB_CENT).bps).toBe(15);
    expect(bpsFor(usd(100_000n) + SUB_CENT + 1n).bps).toBe(10);
  });

  it('waives at most under one cent beyond $1,000 on a first swap', () => {
    expect(bpsFor(usd(1_000n) + SUB_CENT, true).amount).toBe(0n);
    expect(bpsFor(usd(1_000n) + SUB_CENT + 1n, true).amount).toBeGreaterThan(0n);
  });
});

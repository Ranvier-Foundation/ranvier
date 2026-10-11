import { describe, expect, it } from 'vitest';
import type { Token } from '@ranvier/types';
import { feeAmount, feeRate, MAX_FEE_BPS, quoteFee, type FeeInput } from './schedule.js';

const ETH: Token = { chain: 'evm:1', address: 'native', symbol: 'ETH', decimals: 18 };
const WETH: Token = {
  chain: 'evm:1',
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  decimals: 18,
};
const USDC: Token = {
  chain: 'evm:1',
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  decimals: 6,
};
const USDT: Token = {
  chain: 'evm:1',
  address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  symbol: 'USDT',
  decimals: 6,
};
const BASE_WETH: Token = {
  chain: 'evm:8453',
  address: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
};

const base: FeeInput = {
  sellToken: ETH,
  buyToken: USDC,
  sellAmount: 10n ** 18n,
  usdValue: 5_000_00n,
  isFirstSwap: false,
};
const rate = (o: Partial<FeeInput>) => feeRate({ ...base, ...o });

describe('feeRate tiers', () => {
  it.each([
    [0n, 20],
    [9_999_99n, 20],
    [10_000_00n, 15],
    [100_000_00n, 15],
    [100_000_01n, 10],
  ])('usd cents %s -> %i bps', (usdValue, bps) => {
    expect(rate({ usdValue }).bps).toBe(bps);
  });

  it('rejects negative USD values', () => {
    expect(() => rate({ usdValue: -1n })).toThrow(RangeError);
  });
});

describe('feeRate special cases', () => {
  it('is free for wrap and unwrap', () => {
    expect(rate({ sellToken: ETH, buyToken: WETH })).toEqual({ bps: 0, reason: 'wrap-unwrap' });
    expect(rate({ sellToken: WETH, buyToken: ETH }).bps).toBe(0);
  });

  it('does not treat cross-chain native to wrapped as a wrap', () => {
    expect(rate({ sellToken: ETH, buyToken: BASE_WETH }).reason).toBe('tier-under-10k');
  });

  it('charges 5 bps for stablecoin pairs at any size', () => {
    expect(rate({ sellToken: USDC, buyToken: USDT, usdValue: 500_000_00n })).toEqual({
      bps: 5,
      reason: 'stablecoin',
    });
  });

  it('does not give the stablecoin rate when only one side is a stablecoin', () => {
    expect(rate({ sellToken: USDC, buyToken: ETH }).bps).toBe(20);
  });

  it('waives the first swap up to and including $1,000', () => {
    expect(rate({ isFirstSwap: true, usdValue: 1_000_00n })).toEqual({
      bps: 0,
      reason: 'first-swap-promo',
    });
    expect(rate({ isFirstSwap: true, usdValue: 1_000_01n }).bps).toBe(20);
  });
});

describe('feeAmount', () => {
  it('floors to base units', () => {
    expect(feeAmount(1_000_000n, 20)).toBe(2_000n);
    expect(feeAmount(49n, 20)).toBe(0n);
  });

  it('enforces the contract cap and integer bps', () => {
    expect(feeAmount(10_000n, MAX_FEE_BPS)).toBe(30n);
    expect(() => feeAmount(1n, MAX_FEE_BPS + 1)).toThrow(RangeError);
    expect(() => feeAmount(1n, -1)).toThrow(RangeError);
    expect(() => feeAmount(1n, 1.5)).toThrow(RangeError);
    expect(() => feeAmount(-1n, 1)).toThrow(RangeError);
  });

  it('never exceeds the cap for any schedule output', () => {
    for (const usdValue of [0n, 1_000_00n, 50_000_00n, 10n ** 12n]) {
      expect(rate({ usdValue }).bps).toBeLessThanOrEqual(MAX_FEE_BPS);
    }
  });
});

describe('quoteFee', () => {
  it('combines rate and amount', () => {
    expect(quoteFee(base)).toEqual({ bps: 20, reason: 'tier-under-10k', amount: 2n * 10n ** 15n });
  });
});

import { describe, expect, it } from 'vitest';
import type { Token } from '@ranvier/types';
import {
  FEE_SCHEDULE,
  feeAmount,
  feeRate,
  isWrapOrUnwrap,
  MAX_FEE_BPS,
  quoteFee,
  type FeeInput,
} from './schedule.js';

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

  it('detects wrap and unwrap only for native and the same chain wrapped native', () => {
    expect(isWrapOrUnwrap(ETH, WETH)).toBe(true);
    expect(isWrapOrUnwrap(WETH, ETH)).toBe(true);
    expect(isWrapOrUnwrap(ETH, BASE_WETH)).toBe(false);
    expect(isWrapOrUnwrap(ETH, USDC)).toBe(false);
    expect(isWrapOrUnwrap(WETH, WETH)).toBe(false);
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
    expect(quoteFee(base)).toEqual({
      bps: 20,
      reason: 'tier-under-10k',
      amount: 2n * 10n ** 15n,
      waivedUsd: 0n,
    });
  });

  describe('first-swap promotion: the first $1,000 is free', () => {
    const usdc = (dollars: bigint) => dollars * 10n ** 6n;
    const first = (usdValue: bigint, sellAmount: bigint, o: Partial<FeeInput> = {}) =>
      quoteFee({
        ...base,
        sellToken: USDC,
        buyToken: ETH,
        sellAmount,
        usdValue,
        isFirstSwap: true,
        ...o,
      });

    it('is fully free up to and including $1,000', () => {
      expect(first(1_000_00n, usdc(1_000n))).toEqual({
        bps: 20,
        reason: 'first-swap-promo',
        amount: 0n,
        waivedUsd: 1_000_00n,
      });
      expect(first(0n, 0n).amount).toBe(0n);
    });

    it('charges the base rate only on the part above $1,000', () => {
      // $1,500 at 0.2%: fee on $500 = $1.
      expect(first(1_500_00n, usdc(1_500n))).toEqual({
        bps: 20,
        reason: 'first-swap-promo',
        amount: usdc(1n),
        waivedUsd: 1_000_00n,
      });
    });

    it('keeps the tier of the full swap size', () => {
      // $50,000 is in the 0.15% tier: fee on $49,000 = $73.50.
      expect(first(50_000_00n, usdc(50_000n)).amount).toBe(73_500_000n);
    });

    it('applies on top of the stablecoin rate', () => {
      // $11,000 USDC to USDT at 0.05%: fee on $10,000 = $5.
      expect(first(11_000_00n, usdc(11_000n), { buyToken: USDT })).toMatchObject({
        bps: 5,
        amount: usdc(5n),
      });
    });

    it('does not apply to free wraps', () => {
      expect(quoteFee({ ...base, sellToken: ETH, buyToken: WETH, isFirstSwap: true })).toEqual({
        bps: 0,
        reason: 'wrap-unwrap',
        amount: 0n,
        waivedUsd: 0n,
      });
    });

    it('never charges more than the same swap without the promotion', () => {
      for (const dollars of [1_001n, 9_999n, 10_000n, 100_000n, 100_001n, 5_000_000n]) {
        const promo = first(dollars * 100n, usdc(dollars));
        const normal = quoteFee({
          ...base,
          sellToken: USDC,
          buyToken: ETH,
          sellAmount: usdc(dollars),
          usdValue: dollars * 100n,
        });
        expect(promo.amount).toBeLessThan(normal.amount);
        expect(promo.amount * 10_000n).toBeLessThanOrEqual(usdc(dollars) * BigInt(MAX_FEE_BPS));
      }
    });
  });
});

describe('FEE_SCHEDULE', () => {
  const cases: [string, FeeInput, number][] = [
    ['wrap', { ...base, sellToken: ETH, buyToken: WETH }, FEE_SCHEDULE.wrapUnwrapBps],
    ['stablecoin pair', { ...base, sellToken: USDC, buyToken: USDT }, FEE_SCHEDULE.stablecoinBps],
    ['tier 1', { ...base, usdValue: FEE_SCHEDULE.tier1.upperUsd - 1n }, FEE_SCHEDULE.tier1.bps],
    [
      'tier 2 lower bound',
      { ...base, usdValue: FEE_SCHEDULE.tier1.upperUsd },
      FEE_SCHEDULE.tier2.bps,
    ],
    [
      'tier 2 upper bound',
      { ...base, usdValue: FEE_SCHEDULE.tier2.upperUsd },
      FEE_SCHEDULE.tier2.bps,
    ],
    ['tier 3', { ...base, usdValue: FEE_SCHEDULE.tier2.upperUsd + 1n }, FEE_SCHEDULE.tier3.bps],
  ];
  it.each(cases)('feeRate follows the schedule constant: %s', (_name, input, bps) => {
    expect(feeRate(input).bps).toBe(bps);
  });

  it('holds the documented values and stays within the contract cap', () => {
    expect(FEE_SCHEDULE).toEqual({
      wrapUnwrapBps: 0,
      stablecoinBps: 5,
      tier1: { upperUsd: 1_000_000n, bps: 20 },
      tier2: { upperUsd: 10_000_000n, bps: 15 },
      tier3: { bps: 10 },
      firstSwapFreeUsd: 100_000n,
      maxBps: 30,
    });
    for (const bps of [
      FEE_SCHEDULE.wrapUnwrapBps,
      FEE_SCHEDULE.stablecoinBps,
      FEE_SCHEDULE.tier1.bps,
      FEE_SCHEDULE.tier2.bps,
      FEE_SCHEDULE.tier3.bps,
    ]) {
      expect(bps).toBeLessThanOrEqual(FEE_SCHEDULE.maxBps);
    }
  });
});

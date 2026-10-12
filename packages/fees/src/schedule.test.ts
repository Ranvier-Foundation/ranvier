import { describe, expect, it } from 'vitest';
import type { Token } from '@ranvier/types';
import {
  BPS_DENOMINATOR,
  FEE_SCHEDULE,
  FIRST_SWAP_PROMO_CAP,
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

describe('stablecoin allowlist per chain (spec section 2: USDC, USDT, DAI on every chain)', () => {
  const tok = (
    chain: Token['chain'],
    address: string,
    symbol: string,
    decimals: number,
  ): Token => ({
    chain,
    address,
    symbol,
    decimals,
  });
  const BASE_USDC = tok('evm:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6);
  const BASE_DAI = tok('evm:8453', '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', 'DAI', 18);
  const ARB_USDC = tok('evm:42161', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC', 6);
  const ARB_USDT0 = tok('evm:42161', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 'USDT0', 6);
  const ARB_DAI = tok('evm:42161', '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', 'DAI', 18);
  const ARB_WETH = tok('evm:42161', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 'WETH', 18);
  const CBBTC = tok('evm:8453', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 'cbBTC', 8);
  const USDC_1000 = 1_000_000_000n; // 1,000 USDC or USDT0 (6 decimals)
  const DAI_1000 = 1_000n * 10n ** 18n; // 1,000 DAI (18 decimals)
  const swap = (sellToken: Token, buyToken: Token, sellAmount: bigint, usdValue = 1_000_00n) =>
    quoteFee({ sellToken, buyToken, sellAmount, usdValue, isFirstSwap: false });

  it('charges exactly 5 bps for USDC <-> DAI on Base', () => {
    expect(swap(BASE_USDC, BASE_DAI, USDC_1000)).toEqual({
      bps: 5,
      reason: 'stablecoin',
      amount: 500_000n,
      waivedUsd: 0n,
    });
    expect(swap(BASE_DAI, BASE_USDC, DAI_1000)).toEqual({
      bps: 5,
      reason: 'stablecoin',
      amount: 5n * 10n ** 17n,
      waivedUsd: 0n,
    });
  });

  it('charges exactly 5 bps for USDC <-> USDT0 and DAI -> USDC on Arbitrum', () => {
    expect(swap(ARB_USDC, ARB_USDT0, USDC_1000)).toEqual({
      bps: 5,
      reason: 'stablecoin',
      amount: 500_000n,
      waivedUsd: 0n,
    });
    expect(swap(ARB_USDT0, ARB_USDC, USDC_1000)).toEqual({
      bps: 5,
      reason: 'stablecoin',
      amount: 500_000n,
      waivedUsd: 0n,
    });
    expect(swap(ARB_DAI, ARB_USDC, DAI_1000)).toEqual({
      bps: 5,
      reason: 'stablecoin',
      amount: 5n * 10n ** 17n,
      waivedUsd: 0n,
    });
  });

  it('keeps the size tiers for a stablecoin against a non-stablecoin', () => {
    expect(swap(BASE_USDC, BASE_WETH, USDC_1000)).toEqual({
      bps: 20,
      reason: 'tier-under-10k',
      amount: 2_000_000n,
      waivedUsd: 0n,
    });
    expect(swap(ARB_USDT0, ARB_WETH, USDC_1000).bps).toBe(20);
    expect(swap(CBBTC, BASE_USDC, 10n ** 8n, 82_000_00n).bps).toBe(15);
  });

  it('pins current behaviour: a cross-chain pair of stablecoins also pays 5 bps', () => {
    // isStablePair checks each token on its own chain; this test only documents it.
    expect(swap(BASE_USDC, ARB_DAI, USDC_1000)).toEqual({
      bps: 5,
      reason: 'stablecoin',
      amount: 500_000n,
      waivedUsd: 0n,
    });
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

describe('FEE_SCHEDULE is immutable at runtime', () => {
  /** The schedule as plain mutable data, to attempt the writes `as const` forbids at compile time. */
  type Mutable = {
    wrapUnwrapBps: number;
    stablecoinBps: number;
    tier1: { upperUsd: bigint; bps: number };
    tier2: { upperUsd: bigint; bps: number };
    tier3: { bps: number };
    firstSwapFreeUsd: bigint;
    maxBps: number;
  };
  const mutable = FEE_SCHEDULE as unknown as Mutable;

  it('freezes the outer object and every nested object', () => {
    expect(Object.isFrozen(FEE_SCHEDULE)).toBe(true);
    for (const value of Object.values(FEE_SCHEDULE) as unknown[]) {
      if (typeof value === 'object' && value !== null) expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.isFrozen(FEE_SCHEDULE.tier1)).toBe(true);
    expect(Object.isFrozen(FEE_SCHEDULE.tier2)).toBe(true);
    expect(Object.isFrozen(FEE_SCHEDULE.tier3)).toBe(true);
  });

  it('throws on assignment in strict mode (ES modules are strict)', () => {
    expect(() => {
      mutable.tier1.bps = 30;
    }).toThrow(TypeError);
    expect(() => {
      mutable.tier2.upperUsd = 0n;
    }).toThrow(TypeError);
    expect(() => {
      mutable.tier3.bps = 30;
    }).toThrow(TypeError);
    expect(() => {
      mutable.stablecoinBps = 30;
    }).toThrow(TypeError);
    expect(() => {
      mutable.tier1 = { upperUsd: 0n, bps: 30 };
    }).toThrow(TypeError);
    expect(() => {
      (mutable as unknown as Record<string, unknown>).extra = 1;
    }).toThrow(TypeError);
  });

  it('feeRate still returns the documented rates after a mutation attempt', () => {
    const attempts: (() => void)[] = [
      () => (mutable.tier1.bps = 30),
      () => (mutable.tier1.upperUsd = 0n),
      () => (mutable.tier2.bps = 30),
      () => (mutable.tier3.bps = 30),
      () => (mutable.stablecoinBps = 30),
      () => (mutable.wrapUnwrapBps = 30),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(TypeError);
    expect(rate({ usdValue: 9_999_99n })).toEqual({ bps: 20, reason: 'tier-under-10k' });
    expect(rate({ usdValue: 10_000_00n })).toEqual({ bps: 15, reason: 'tier-10k-100k' });
    expect(rate({ usdValue: 100_000_00n })).toEqual({ bps: 15, reason: 'tier-10k-100k' });
    expect(rate({ usdValue: 100_000_01n })).toEqual({ bps: 10, reason: 'tier-over-100k' });
    expect(rate({ sellToken: USDC, buyToken: USDT })).toEqual({ bps: 5, reason: 'stablecoin' });
    expect(rate({ sellToken: ETH, buyToken: WETH })).toEqual({ bps: 0, reason: 'wrap-unwrap' });
  });

  it('keeps the exported primitives at their documented values', () => {
    expect(MAX_FEE_BPS).toBe(30);
    expect(BPS_DENOMINATOR).toBe(10_000n);
    expect(FIRST_SWAP_PROMO_CAP).toBe(100_000n);
    expect(FEE_SCHEDULE.maxBps).toBe(MAX_FEE_BPS);
    expect(FEE_SCHEDULE.firstSwapFreeUsd).toBe(FIRST_SWAP_PROMO_CAP);
  });
});

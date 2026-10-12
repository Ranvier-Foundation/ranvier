import { describe, expect, it } from 'vitest';
import type { QuoteRequest } from '@ranvier/types';
import type { Hex } from 'viem';
import fixture from '../adapters/providers/fixtures/zero-x-quote.json' with { type: 'json' };
import {
  ALLOWANCE_HOLDER,
  ATTACKER,
  execCalldata,
  SETTLER,
  settlerCalldata,
  TEST_POLICY,
  zeroXRoute,
  type ExecArgs,
} from '../testing/zero-x-route.js';
import { TRUSTED_ROUTERS } from '../trusted-routers.js';
import { ZEROX_NATIVE_IN, ZEROX_NATIVE_OUT } from './allowance-holder.js';
import {
  checkOracleValue,
  signedMinimum,
  slippageFloor,
  UnsafeRouteError,
  vetRoute,
  type UnsafeRouteReason,
  type VetContext,
} from './route-safety.js';

const USER: Hex = '0x00000000000000000000000000000000000000aa';
const USDC: Hex = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH: Hex = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const E18 = 10n ** 18n;

/** 1,000 USDC (net of fee) for WETH at $2,500: a fair output is 0.4 WETH. */
const request: QuoteRequest = {
  sellToken: { chain: 'evm:1', address: USDC },
  buyToken: { chain: 'evm:1', address: WETH },
  sellAmount: 1_000n * 10n ** 6n,
  taker: USER,
  slippageBps: 50,
};
const ctx: VetContext = {
  request,
  sellPrice: { decimals: 6, usdE18: E18 },
  buyPrice: { decimals: 18, usdE18: 2_500n * E18 },
  policy: TEST_POLICY,
  maxOracleDeviationBps: 500,
};
const FAIR = 4n * 10n ** 17n;
const FAIR_MIN = (FAIR * 9_950n) / 10_000n;
const honest: ExecArgs = {
  operator: SETTLER,
  token: USDC,
  amount: request.sellAmount,
  target: SETTLER,
  recipient: USER,
  buyToken: WETH,
  minAmountOut: FAIR_MIN,
};
const route = (args: Partial<Parameters<typeof zeroXRoute>[1]> = {}) =>
  zeroXRoute(honest, { buyAmount: FAIR, minBuyAmount: FAIR_MIN, ...args });

function expectRejected(fn: () => unknown, reason: UnsafeRouteReason): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UnsafeRouteError);
    expect((err as UnsafeRouteError).reason).toBe(reason);
    expect((err as UnsafeRouteError).message).toBe(`unsafe route: ${reason}`);
    return;
  }
  throw new Error(`expected rejection: ${reason}`);
}

describe('vetRoute: honest routes', () => {
  it('accepts a consistent route and signs at least the slippage floor', () => {
    const vetted = vetRoute(ctx, route());
    expect(vetted.buyAmount).toBe(FAIR);
    expect(vetted.minBuyAmount).toBe(FAIR_MIN);
  });

  it('accepts the real recorded 0x response against the production Settler allowlist', () => {
    // Base USDC -> WETH, recorded 2026-10-12; Settler 0x4f6f... is the registry's prev(2).
    const base: QuoteRequest = {
      sellToken: { chain: 'evm:8453', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
      buyToken: { chain: 'evm:8453', address: '0x4200000000000000000000000000000000000006' },
      sellAmount: BigInt(fixture.sellAmount),
      taker: '0x2222222222222222222222222222222222222222',
      slippageBps: 50,
    };
    const buyAmount = BigInt(fixture.buyAmount);
    const vetted = vetRoute(
      {
        request: base,
        sellPrice: { decimals: 6, usdE18: E18 },
        buyPrice: { decimals: 18, usdE18: 2_556n * E18 },
        policy: TRUSTED_ROUTERS,
        maxOracleDeviationBps: 500,
      },
      {
        provider: '0x',
        buyAmount,
        minBuyAmount: BigInt(fixture.minBuyAmount),
        buyAmountUsd: 0n,
        gasCostUsd: 0n,
        route: [],
        tx: { to: fixture.transaction.to, data: fixture.transaction.data, value: 0n },
      },
    );
    // 0x rounds its minimum down; the signed minimum rounds up, in the user's favour.
    expect(BigInt(fixture.minBuyAmount)).toBe(slippageFloor(buyAmount, 50));
    expect(vetted.minBuyAmount).toBe(BigInt(fixture.minBuyAmount) + 1n);
    expect(vetted.minBuyAmount).toBe(signedMinimum(buyAmount, 50));
  });

  it('accepts native input encoded as the zero address with the amount as value', () => {
    const native = { ...request, sellToken: { chain: 'evm:1' as const, address: 'native' } };
    const nativeCtx = {
      ...ctx,
      request: native,
      sellPrice: { decimals: 18, usdE18: 2_500n * E18 },
    };
    const amount = 4n * 10n ** 17n;
    const r = zeroXRoute(
      { ...honest, token: ZEROX_NATIVE_IN, amount },
      { buyAmount: FAIR, minBuyAmount: FAIR_MIN, value: amount },
    );
    expect(
      vetRoute({ ...nativeCtx, request: { ...native, sellAmount: amount } }, r).buyAmount,
    ).toBe(FAIR);
  });

  it('accepts native output encoded as 0xeeee...eeee', () => {
    const toEth = { ...request, buyToken: { chain: 'evm:1' as const, address: 'native' } };
    const r = route({ buyToken: ZEROX_NATIVE_OUT });
    expect(vetRoute({ ...ctx, request: toEth }, r).buyAmount).toBe(FAIR);
  });

  it('keeps a provider minimum above the slippage floor', () => {
    expect(vetRoute(ctx, route({ minBuyAmount: FAIR })).minBuyAmount).toBe(FAIR);
  });

  it('matches router addresses case-insensitively', () => {
    const r = route({ to: '0x0000000000001fF3684f28c67538d4D072C22734' });
    expect(vetRoute(ctx, r).provider).toBe('0x');
  });
});

describe('vetRoute: crafted malicious responses', () => {
  it('rejects an attacker as operator and target', () => {
    expectRejected(
      () => vetRoute(ctx, route({ operator: ATTACKER, target: ATTACKER })),
      'unknown_target',
    );
  });

  it('rejects an attacker operator with a trusted target', () => {
    expectRejected(() => vetRoute(ctx, route({ operator: ATTACKER })), 'operator_not_target');
  });

  it('rejects a trusted operator with an attacker target', () => {
    expectRejected(() => vetRoute(ctx, route({ target: ATTACKER })), 'operator_not_target');
  });

  it('rejects an unknown Settler (e.g. after a 0x rotation, until the allowlist is updated)', () => {
    const next: Hex = '0x00000000000000000000000000000000005e7714';
    expectRejected(() => vetRoute(ctx, route({ operator: next, target: next })), 'unknown_target');
  });

  it('rejects the wrong input token', () => {
    expectRejected(() => vetRoute(ctx, route({ token: WETH })), 'wrong_input_token');
  });

  it('rejects the 0xeeee sentinel as native input token', () => {
    const native = { ...request, sellToken: { chain: 'evm:1' as const, address: 'native' } };
    const r = route({ token: ZEROX_NATIVE_OUT, value: request.sellAmount });
    expectRejected(() => vetRoute({ ...ctx, request: native }, r), 'wrong_input_token');
  });

  it('rejects an input amount other than sellAmount - fee', () => {
    expectRejected(
      () => vetRoute(ctx, route({ amount: request.sellAmount + 1n })),
      'wrong_input_amount',
    );
    expectRejected(
      () => vetRoute(ctx, route({ amount: request.sellAmount - 1n })),
      'wrong_input_amount',
    );
  });

  it('rejects output paid to someone other than the user', () => {
    expectRejected(() => vetRoute(ctx, route({ recipient: ATTACKER })), 'wrong_recipient');
  });

  it('rejects the wrong output token', () => {
    expectRejected(() => vetRoute(ctx, route({ buyToken: USDC })), 'wrong_output_token');
  });

  it('rejects minBuyAmount 0', () => {
    expectRejected(() => vetRoute(ctx, route({ minBuyAmount: 0n })), 'minimum_below_slippage');
  });

  it('rejects a calldata minimum that differs from the reported one', () => {
    expectRejected(() => vetRoute(ctx, route({ minAmountOut: 0n })), 'calldata_minimum_mismatch');
  });

  it('rejects a minimum below the requested slippage', () => {
    expectRejected(
      () => vetRoute(ctx, route({ minBuyAmount: slippageFloor(FAIR, 50) - 1n })),
      'minimum_below_slippage',
    );
  });

  it('rejects a minimum above the output', () => {
    expectRejected(() => vetRoute(ctx, route({ minBuyAmount: FAIR + 1n })), 'minimum_above_output');
  });

  it('rejects a zero output', () => {
    expectRejected(() => vetRoute(ctx, route({ buyAmount: 0n, minBuyAmount: 0n })), 'zero_output');
  });

  it('rejects an output far below the oracle value', () => {
    const low = FAIR / 2n;
    expectRejected(
      () => vetRoute(ctx, route({ buyAmount: low, minBuyAmount: slippageFloor(low, 50) })),
      'below_oracle_value',
    );
  });

  it('rejects an unknown router', () => {
    expectRejected(() => vetRoute(ctx, route({ to: ATTACKER })), 'unknown_router');
  });

  it('rejects a value inconsistent with the input', () => {
    expectRejected(() => vetRoute(ctx, route({ value: 1n })), 'wrong_value');
    const native = { ...request, sellToken: { chain: 'evm:1' as const, address: 'native' } };
    const r = route({ token: ZEROX_NATIVE_IN, value: 0n });
    expectRejected(() => vetRoute({ ...ctx, request: native }, r), 'wrong_value');
  });

  it('rejects calldata that is not AllowanceHolder exec -> Settler execute', () => {
    expectRejected(() => vetRoute(ctx, route({ data: '0x' })), 'malformed_calldata');
    expectRejected(
      () => vetRoute(ctx, route({ data: settlerCalldata(honest) })),
      'malformed_calldata',
    );
    expectRejected(
      () => vetRoute(ctx, route({ data: execCalldata(honest, '0xdeadbeef') })),
      'malformed_calldata',
    );
    // Right selector, truncated arguments.
    expectRejected(() => vetRoute(ctx, route({ data: '0x2213bc0b0000' })), 'malformed_calldata');
  });

  it('rejects chains without a policy, non-EVM and cross-chain requests', () => {
    const on = (sell: string, buy: string) => ({
      ...ctx,
      request: {
        ...request,
        sellToken: { chain: sell as 'evm:1', address: USDC },
        buyToken: { chain: buy as 'evm:1', address: WETH },
      },
    });
    expectRejected(() => vetRoute(on('evm:10', 'evm:10'), route()), 'unknown_router');
    expectRejected(
      () => vetRoute(on('solana:mainnet', 'solana:mainnet'), route()),
      'unsupported_chain',
    );
    expectRejected(() => vetRoute(on('evm:1', 'evm:8453'), route()), 'unsupported_chain');
  });
});

describe('slippage bounds', () => {
  it('floors the provider tolerance and rounds the signed minimum up', () => {
    expect(slippageFloor(1_001n, 50)).toBe(995n); // 995.995
    expect(signedMinimum(1_001n, 50)).toBe(996n);
    expect(signedMinimum(1_000n, 50)).toBe(995n); // exact: no rounding
    expect(signedMinimum(1_000n, 0)).toBe(1_000n);
    expect(slippageFloor(1_000n, 10_000)).toBe(0n);
  });
});

describe('checkOracleValue', () => {
  const prices = { sellPrice: ctx.sellPrice, buyPrice: ctx.buyPrice, maxOracleDeviationBps: 500 };
  it('allows exactly the configured deviation and no more', () => {
    // $1,000 in; 5% below is $950 = 0.38 WETH.
    expect(() => checkOracleValue(prices, 1_000n * 10n ** 6n, 38n * 10n ** 16n)).not.toThrow();
    expect(() => checkOracleValue(prices, 1_000n * 10n ** 6n, 38n * 10n ** 16n - 1n)).toThrow(
      UnsafeRouteError,
    );
  });

  it('allows outputs above the oracle value (positive slippage)', () => {
    expect(() => checkOracleValue(prices, 10n ** 6n, E18)).not.toThrow();
  });

  it('keeps precision below one cent for tiny swaps', () => {
    // 1 USDC base unit ($0.000001) for 4e8 wei ($0.000001): equal value, must pass.
    expect(() => checkOracleValue(prices, 1n, 4n * 10n ** 8n)).not.toThrow();
    expect(() => checkOracleValue(prices, 1n, 3n * 10n ** 8n)).toThrow(UnsafeRouteError);
  });

  it('with deviation 0 requires at least oracle parity', () => {
    const strict = { ...prices, maxOracleDeviationBps: 0 };
    expect(() => checkOracleValue(strict, 1_000n * 10n ** 6n, FAIR)).not.toThrow();
    expect(() => checkOracleValue(strict, 1_000n * 10n ** 6n, FAIR - 1n)).toThrow(UnsafeRouteError);
  });
});

describe('fixture selector', () => {
  it('is AllowanceHolder exec targeting the trusted Base Settler', () => {
    expect(fixture.transaction.data.slice(0, 10)).toBe('0x2213bc0b');
    expect(fixture.transaction.to).toBe(ALLOWANCE_HOLDER);
  });
});

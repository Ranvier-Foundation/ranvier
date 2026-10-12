import { describe, expect, it } from 'vitest';
import { toFunctionSelector } from 'viem';
import fixture from '../adapters/providers/fixtures/zero-x-quote.json' with { type: 'json' };
import {
  ALLOWANCE_HOLDER_ABI,
  ALLOWANCE_HOLDER_EXEC_SELECTOR,
  decodeAllowanceHolderExec,
  decodeSettlerExecute,
  SETTLER_ABI,
  SETTLER_EXECUTE_SELECTOR,
} from './allowance-holder.js';

describe('0x calldata decoding', () => {
  it('uses the selectors of the published signatures', () => {
    expect(toFunctionSelector(ALLOWANCE_HOLDER_ABI[0])).toBe(ALLOWANCE_HOLDER_EXEC_SELECTOR);
    expect(toFunctionSelector(SETTLER_ABI[0])).toBe(SETTLER_EXECUTE_SELECTOR);
  });

  it('decodes the recorded live response (Base USDC -> WETH)', () => {
    const exec = decodeAllowanceHolderExec(fixture.transaction.data as `0x${string}`);
    expect(exec).toMatchObject({
      operator: '0x4f6f91599858bf0d19fabcf2c5d591fe13f7c059',
      token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      amount: BigInt(fixture.sellAmount),
      target: '0x4f6f91599858bf0d19fabcf2c5d591fe13f7c059',
    });
    expect(decodeSettlerExecute(exec.data)).toEqual({
      recipient: '0x2222222222222222222222222222222222222222',
      buyToken: '0x4200000000000000000000000000000000000006',
      minAmountOut: BigInt(fixture.minBuyAmount),
    });
  });

  it('refuses other selectors', () => {
    expect(() => decodeAllowanceHolderExec('0xdeadbeef')).toThrow('not an AllowanceHolder exec');
    expect(() => decodeSettlerExecute('0xdeadbeef')).toThrow('not a Settler execute');
  });
});

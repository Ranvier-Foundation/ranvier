import { describe, expect, it } from 'vitest';
import { toFunctionSelector, type Hex } from 'viem';
import { execCalldata, settlerCalldata, SETTLER } from '../testing/zero-x-route.js';
import fixture from '../adapters/providers/fixtures/zero-x-quote.json' with { type: 'json' };
import { decodeFunctionData } from 'viem';
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

  describe('canonical encoding', () => {
    const args = {
      operator: SETTLER as Hex,
      token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Hex,
      amount: 10n ** 9n,
      target: SETTLER as Hex,
      recipient: '0x00000000000000000000000000000000000000aa' as Hex,
      buyToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Hex,
      minAmountOut: 1n,
    };
    const exec = execCalldata(args);
    const inner = settlerCalldata(args);
    /** Replaces the 32-byte word at `index` (after the 4-byte selector). */
    const setWord = (data: Hex, index: number, word: string): Hex => {
      const start = 10 + index * 64;
      return `${data.slice(0, start)}${word}${data.slice(start + 64)}` as Hex;
    };

    it('accepts canonical calldata', () => {
      expect(decodeAllowanceHolderExec(exec).amount).toBe(10n ** 9n);
      expect(decodeSettlerExecute(inner).minAmountOut).toBe(1n);
    });

    it('refuses dirty high bits in an address word', () => {
      const operatorWord = exec.slice(10, 74);
      const dirty = setWord(exec, 0, `ff${operatorWord.slice(2)}`);
      expect(() => decodeAllowanceHolderExec(dirty)).toThrow();
      const recipientWord = inner.slice(10, 74);
      const dirtyInner = setWord(inner, 0, `ff${recipientWord.slice(2)}`);
      expect(() => decodeSettlerExecute(dirtyInner)).toThrow();
    });

    it('refuses trailing bytes', () => {
      expect(() => decodeAllowanceHolderExec(`${exec}00` as Hex)).toThrow('non-canonical');
      expect(() => decodeAllowanceHolderExec(`${exec}${'00'.repeat(32)}` as Hex)).toThrow(
        'non-canonical',
      );
      expect(() => decodeSettlerExecute(`${inner}${'00'.repeat(32)}` as Hex)).toThrow(
        'non-canonical',
      );
    });

    it('refuses an altered offset to the same bytes', () => {
      // Word 4 is the offset of `data` (0xa0). Point it 32 bytes later and append a copy of
      // the tail there: a lenient decoder reads the same bytes, re-encoding does not match.
      const offsetWord = exec.slice(10 + 4 * 64, 10 + 5 * 64);
      expect(BigInt(`0x${offsetWord}`)).toBe(0xa0n);
      const tail = exec.slice(10 + 5 * 64);
      const shifted = `${setWord(exec, 4, (0xc0).toString(16).padStart(64, '0')).slice(
        0,
        10 + 5 * 64,
      )}${'00'.repeat(32)}${tail}` as Hex;
      expect(decodeAllowanceHolderExecLenient(shifted)).toBe(true);
      expect(() => decodeAllowanceHolderExec(shifted)).toThrow('non-canonical');
    });
  });
});

/** True when viem alone (no canonical check) still decodes the calldata. */
function decodeAllowanceHolderExecLenient(data: Hex): boolean {
  decodeFunctionData({ abi: ALLOWANCE_HOLDER_ABI, data });
  return true;
}

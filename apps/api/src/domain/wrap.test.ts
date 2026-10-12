import { describe, expect, it } from 'vitest';
import type { Token } from '@ranvier/types';
import { maxUint256 } from 'viem';
import { buildDirectWrap } from './wrap.js';

const ETH: Token = { chain: 'evm:1', address: 'native', symbol: 'ETH', decimals: 18 };
const WETH: Token = {
  chain: 'evm:1',
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  decimals: 18,
};
const WETH_CONTRACT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const BASE_ETH: Token = { chain: 'evm:8453', address: 'native', symbol: 'ETH', decimals: 18 };
const BASE_WETH: Token = {
  chain: 'evm:8453',
  address: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
};
const USDC: Token = {
  chain: 'evm:1',
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  symbol: 'USDC',
  decimals: 6,
};
const SOL: Token = { chain: 'solana:mainnet', address: 'native', symbol: 'SOL', decimals: 9 };
const WSOL: Token = {
  chain: 'solana:mainnet',
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'wSOL',
  decimals: 9,
};

const AMOUNT = 1_234_567_890_123_456_789n;
const DEPOSIT_SELECTOR = '0xd0e30db0';
const WITHDRAW_SELECTOR = '0x2e1a7d4d';

describe('buildDirectWrap', () => {
  it('wraps native with deposit() and sends the amount as value', () => {
    expect(buildDirectWrap({ sellToken: ETH, buyToken: WETH, sellAmount: AMOUNT })).toEqual({
      kind: 'wrap',
      transaction: { to: WETH_CONTRACT, data: DEPOSIT_SELECTOR, value: AMOUNT },
      buyAmount: AMOUNT,
      minBuyAmount: AMOUNT,
    });
  });

  it('unwraps with withdraw(wad) and no value', () => {
    const wad = AMOUNT.toString(16).padStart(64, '0');
    expect(buildDirectWrap({ sellToken: WETH, buyToken: ETH, sellAmount: AMOUNT })).toEqual({
      kind: 'unwrap',
      transaction: { to: WETH_CONTRACT, data: `${WITHDRAW_SELECTOR}${wad}`, value: 0n },
      buyAmount: AMOUNT,
      minBuyAmount: AMOUNT,
    });
  });

  it('matches the wrapped native address in any letter case and uses the chain registry', () => {
    const lower = { ...BASE_WETH, address: BASE_WETH.address.toLowerCase() };
    const wrap = buildDirectWrap({ sellToken: BASE_ETH, buyToken: lower, sellAmount: 1n });
    expect(wrap?.transaction.to).toBe('0x4200000000000000000000000000000000000006');
  });

  it('does not treat other pairs as a wrap', () => {
    expect(buildDirectWrap({ sellToken: ETH, buyToken: USDC, sellAmount: 1n })).toBeUndefined();
    expect(
      buildDirectWrap({ sellToken: ETH, buyToken: BASE_WETH, sellAmount: 1n }),
    ).toBeUndefined();
    expect(buildDirectWrap({ sellToken: WETH, buyToken: WETH, sellAmount: 1n })).toBeUndefined();
    expect(
      buildDirectWrap({
        sellToken: { ...ETH, chain: 'evm:999' },
        buyToken: { ...WETH, chain: 'evm:999' },
        sellAmount: 1n,
      }),
    ).toBeUndefined();
  });

  it('leaves Solana wSOL to the existing route', () => {
    expect(buildDirectWrap({ sellToken: SOL, buyToken: WSOL, sellAmount: 1n })).toBeUndefined();
  });

  it('rejects amounts outside uint256', () => {
    expect(() => buildDirectWrap({ sellToken: WETH, buyToken: ETH, sellAmount: 0n })).toThrow(
      RangeError,
    );
    expect(() =>
      buildDirectWrap({ sellToken: WETH, buyToken: ETH, sellAmount: maxUint256 + 1n }),
    ).toThrow(RangeError);
  });
});

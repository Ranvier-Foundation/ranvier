import { FEE_SCHEDULE } from '@ranvier/fees';
import { getChain } from '@ranvier/chains';
import { describe, expect, it } from 'vitest';
import { defaultNetwork, defaultPair } from '../../src/lib/defaults';
import { feeSummary, formatBps } from '../../src/lib/fee-copy';
import { formatUsd, shortAddress } from '../../src/lib/format';
import { t, tPlural } from '../../src/lib/i18n';

describe('formatUsd', () => {
  it.each([
    [0n, '$0.00'],
    [5n, '$0.05'],
    [100_000n, '$1,000.00'],
    [1_234_567_89n, '$1,234,567.89'],
    [-250n, '-$2.50'],
  ])('%s -> %s', (cents, text) => expect(formatUsd(cents)).toBe(text));
});

describe('shortAddress', () => {
  it('shortens long addresses and keeps short ones', () => {
    expect(shortAddress('0x7a3E00000000000000000000000000000000' + '3F9c')).toBe('0x7a3E…3F9c');
    expect(shortAddress('0x1234')).toBe('0x1234');
  });
});

describe('i18n', () => {
  it('fills parameters and leaves unknown ones', () => {
    expect(t('swap.pay.heading', { chain: 'Ethereum' })).toBe('Pay on Ethereum');
    expect(t('swap.pay.heading', {})).toBe('Pay on {chain}');
  });
  it('picks plural forms', () => {
    expect(tPlural('header.activity', 1)).toBe('Activity, 1 swap in progress');
    expect(tPlural('header.activity', 3)).toBe('Activity, 3 swaps in progress');
  });
});

describe('fee copy comes from FEE_SCHEDULE', () => {
  it('formats basis points', () => {
    expect(formatBps(20)).toBe('0.2%');
    expect(formatBps(5)).toBe('0.05%');
    expect(formatBps(30)).toBe('0.3%');
  });
  it('matches the documented schedule', () => {
    expect(feeSummary()).toEqual({
      tier1: '0.2%',
      tier2: '0.15%',
      tier3: '0.1%',
      tier1UpTo: '$10,000.00',
      tier2UpTo: '$100,000.00',
      stablecoin: '0.05%',
      wrapUnwrap: 'Free',
      cap: '0.3%',
      firstSwapFree: '$1,000.00',
    });
  });
  it('is derived from the constant, not retyped', () => {
    const s = feeSummary();
    expect(s.tier1).toBe(formatBps(FEE_SCHEDULE.tier1.bps));
    expect(s.tier2).toBe(formatBps(FEE_SCHEDULE.tier2.bps));
    expect(s.tier3).toBe(formatBps(FEE_SCHEDULE.tier3.bps));
    expect(s.stablecoin).toBe(formatBps(FEE_SCHEDULE.stablecoinBps));
    expect(s.cap).toBe(formatBps(FEE_SCHEDULE.maxBps));
    expect(s.firstSwapFree).toBe(formatUsd(FEE_SCHEDULE.firstSwapFreeUsd));
  });
});

describe('defaults come from the registry', () => {
  it('pairs the native coin on Ethereum with a stablecoin on Base', () => {
    const { pay, receive } = defaultPair();
    expect(pay.chain).toBe(getChain('evm:1'));
    expect(pay.symbol).toBe('ETH');
    expect(receive.chain).toBe(getChain('evm:8453'));
    expect(receive.symbol).toBe('USDC');
  });
  it('uses the first registry chain as the default network', () => {
    expect(defaultNetwork().key).toBe('evm:1');
  });
});

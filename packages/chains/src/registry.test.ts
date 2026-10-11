import { describe, expect, it } from 'vitest';
import { getChain, isStablecoin, isWrappedNative } from './registry.js';

describe('chain registry', () => {
  it('finds chains by key', () => {
    expect(getChain('evm:1')?.name).toBe('Ethereum');
    expect(getChain('evm:999999')).toBeUndefined();
  });

  it('matches EVM stablecoins case-insensitively', () => {
    expect(isStablecoin('evm:1', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true);
    expect(isStablecoin('evm:1', '0x0000000000000000000000000000000000000001')).toBe(false);
  });

  it('matches Solana addresses case-sensitively', () => {
    expect(isStablecoin('solana:mainnet', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(
      true,
    );
    expect(isStablecoin('solana:mainnet', 'epjfwdd5aufqssqem2qn1xzybapc8g4wegGkzwytdt1v')).toBe(
      false,
    );
  });

  it('detects wrapped native tokens', () => {
    expect(isWrappedNative('evm:8453', '0x4200000000000000000000000000000000000006')).toBe(true);
    expect(isWrappedNative('evm:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
  });

  it('returns false for unknown chains', () => {
    expect(isStablecoin('evm:5', '0x00')).toBe(false);
    expect(isWrappedNative('evm:5', '0x00')).toBe(false);
  });
});

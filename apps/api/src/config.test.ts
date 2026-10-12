import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toMatchObject({
      PORT: 4000,
      HOST: '127.0.0.1',
      PROVIDER_TIMEOUT_MS: 700,
      ZEROX_CHAIN_IDS: [1, 8453, 42161],
    });
  });

  it('parses chain lists and rejects bad addresses', () => {
    expect(loadConfig({ ZEROX_CHAIN_IDS: '1, 10' }).ZEROX_CHAIN_IDS).toEqual([1, 10]);
    expect(() => loadConfig({ FEE_WRAPPER_ADDRESS: 'nope' })).toThrow();
  });
});

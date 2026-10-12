import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toMatchObject({
      PORT: 4000,
      HOST: '127.0.0.1',
      PROVIDER_TIMEOUT_MS: 2500,
      ZEROX_CHAIN_IDS: [1, 8453, 42161],
    });
  });

  it('treats empty values as unset', () => {
    const config = loadConfig({
      PORT: '',
      FEE_WRAPPER_ADDRESS: '',
      ZEROX_API_KEY: '  ',
      QUOTE_SIGNER_PRIVATE_KEY: '',
    });
    expect(config).toMatchObject({ PORT: 4000 });
    expect(config.FEE_WRAPPER_ADDRESS).toBeUndefined();
    expect(config.ZEROX_API_KEY).toBeUndefined();
    expect(config.QUOTE_SIGNER_PRIVATE_KEY).toBeUndefined();
  });

  it('still rejects malformed non-empty values', () => {
    expect(() => loadConfig({ QUOTE_SIGNER_PRIVATE_KEY: '0x1234' })).toThrow();
  });

  it('parses chain lists and rejects bad addresses', () => {
    expect(loadConfig({ ZEROX_CHAIN_IDS: '1, 10' }).ZEROX_CHAIN_IDS).toEqual([1, 10]);
    expect(() => loadConfig({ FEE_WRAPPER_ADDRESS: 'nope' })).toThrow();
  });
});

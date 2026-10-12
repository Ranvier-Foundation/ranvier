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

  it('defaults and bounds the safety limits', () => {
    expect(loadConfig({})).toMatchObject({
      MAX_SLIPPAGE_BPS: 1_000,
      MAX_ORACLE_DEVIATION_BPS: 500,
    });
    expect(loadConfig({ MAX_SLIPPAGE_BPS: '5000' }).MAX_SLIPPAGE_BPS).toBe(5_000);
    expect(() => loadConfig({ MAX_SLIPPAGE_BPS: '5001' })).toThrow();
    expect(() => loadConfig({ MAX_ORACLE_DEVIATION_BPS: '-1' })).toThrow();
  });

  it('parses the local signer chain allowlist', () => {
    expect(loadConfig({}).LOCAL_SIGNER_CHAIN_IDS).toBeUndefined();
    expect(loadConfig({ LOCAL_SIGNER_CHAIN_IDS: '31337, 84532' }).LOCAL_SIGNER_CHAIN_IDS).toEqual([
      31337, 84532,
    ]);
    expect(() => loadConfig({ LOCAL_SIGNER_CHAIN_IDS: 'x' })).toThrow();
  });

  describe('KMS signer settings', () => {
    const ARN = 'arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
    const LOCAL_KEY = `0x${'0'.repeat(63)}1`;

    it('accepts key ARNs, aliases, alias ARNs and key IDs with a region', () => {
      for (const id of [
        ARN,
        'alias/ranvier-fee-signer',
        'arn:aws:kms:eu-west-1:111122223333:alias/ranvier-fee-signer',
        '1234abcd-12ab-34cd-56ef-1234567890ab',
        `mrk-${'a'.repeat(32)}`,
      ]) {
        expect(loadConfig({ KMS_KEY_ID: id, AWS_REGION: 'eu-west-1' }).KMS_KEY_ID, id).toBe(id);
      }
      expect(loadConfig({ KMS_KEY_ID: ARN, AWS_REGION: 'eu-west-1' })).toMatchObject({
        AWS_REGION: 'eu-west-1',
        KMS_SIGN_TIMEOUT_MS: 2_000,
        KMS_MAX_IN_FLIGHT: 16,
        KMS_MAX_QUEUE: 64,
      });
    });

    it('rejects malformed key IDs and regions', () => {
      for (const id of ['my-key', 'alias/', 'arn:aws:kms:eu-west-1:1:key/x', 'alias/a b']) {
        expect(() => loadConfig({ KMS_KEY_ID: id, AWS_REGION: 'eu-west-1' }), id).toThrow();
      }
      for (const region of ['EU-WEST-1', 'eu-west', 'europe']) {
        expect(() => loadConfig({ KMS_KEY_ID: ARN, AWS_REGION: region }), region).toThrow();
      }
      expect(loadConfig({ AWS_REGION: 'us-gov-west-1' }).AWS_REGION).toBe('us-gov-west-1');
    });

    it('refuses both signers at once', () => {
      expect(() =>
        loadConfig({
          KMS_KEY_ID: ARN,
          AWS_REGION: 'eu-west-1',
          QUOTE_SIGNER_PRIVATE_KEY: LOCAL_KEY,
        }),
      ).toThrow('Set either KMS_KEY_ID (production) or QUOTE_SIGNER_PRIVATE_KEY');
    });

    it('requires AWS_REGION with KMS_KEY_ID, matching the key ARN', () => {
      expect(() => loadConfig({ KMS_KEY_ID: ARN })).toThrow('AWS_REGION is required');
      expect(() => loadConfig({ KMS_KEY_ID: ARN, AWS_REGION: 'us-east-1' })).toThrow(
        'KMS_KEY_ID is in eu-west-1 but AWS_REGION is us-east-1',
      );
      expect(loadConfig({ KMS_KEY_ID: 'alias/x', AWS_REGION: 'us-east-1' }).AWS_REGION).toBe(
        'us-east-1',
      );
    });

    it('refuses LOCAL_SIGNER_CHAIN_IDS with a KMS key', () => {
      expect(() =>
        loadConfig({ KMS_KEY_ID: ARN, AWS_REGION: 'eu-west-1', LOCAL_SIGNER_CHAIN_IDS: '31337' }),
      ).toThrow('LOCAL_SIGNER_CHAIN_IDS applies to a local key only');
    });

    it('bounds the KMS limits and never reads AWS credentials', () => {
      expect(() => loadConfig({ KMS_SIGN_TIMEOUT_MS: '50' })).toThrow();
      expect(() => loadConfig({ KMS_MAX_IN_FLIGHT: '0' })).toThrow();
      expect(() => loadConfig({ KMS_MAX_QUEUE: '-1' })).toThrow();
      expect(loadConfig({ KMS_MAX_QUEUE: '0' }).KMS_MAX_QUEUE).toBe(0);
      const config = loadConfig({
        AWS_ACCESS_KEY_ID: 'placeholder',
        AWS_SECRET_ACCESS_KEY: 'not-read',
      }) as Record<string, unknown>;
      expect(Object.keys(config).filter((k) => k.startsWith('AWS_'))).toEqual([]);
    });
  });
});

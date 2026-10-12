import { describe, expect, it } from 'vitest';
import { loadConfig, parseWebOrigins } from './config.js';

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

  describe('WEB_ORIGINS (CORS)', () => {
    it('defaults to no origins, and empty means unset', () => {
      expect(loadConfig({}).WEB_ORIGINS).toEqual([]);
      expect(loadConfig({ WEB_ORIGINS: '' }).WEB_ORIGINS).toEqual([]);
      expect(loadConfig({ WEB_ORIGINS: '   ' }).WEB_ORIGINS).toEqual([]);
    });

    it('parses exact origins and trims whitespace around entries', () => {
      expect(
        loadConfig({ WEB_ORIGINS: ' http://localhost:3000 , https://app.ranvier.example ' })
          .WEB_ORIGINS,
      ).toEqual(['http://localhost:3000', 'https://app.ranvier.example']);
      expect(parseWebOrigins('http://[::1]:3000')).toEqual(['http://[::1]:3000']);
    });

    it('refuses http origins in production unless the host is loopback', () => {
      for (const nodeEnv of ['production', ' Production ']) {
        expect(() =>
          loadConfig({ NODE_ENV: nodeEnv, WEB_ORIGINS: 'http://app.ranvier.example' }),
        ).toThrow(/https in production/);
      }
      expect(
        loadConfig({
          NODE_ENV: 'production',
          WEB_ORIGINS:
            'https://app.ranvier.example,http://localhost:3000,http://127.0.0.1:3000,http://[::1]:3000',
        }).WEB_ORIGINS,
      ).toHaveLength(4);
      // Outside production, http is accepted for any host.
      expect(loadConfig({ WEB_ORIGINS: 'http://app.ranvier.example' }).WEB_ORIGINS).toEqual([
        'http://app.ranvier.example',
      ]);
      expect(
        loadConfig({ NODE_ENV: 'development', WEB_ORIGINS: 'http://192.168.1.5:3000' }).WEB_ORIGINS,
      ).toEqual(['http://192.168.1.5:3000']);
      // Look-alike loopback names are not loopback.
      expect(() =>
        loadConfig({ NODE_ENV: 'production', WEB_ORIGINS: 'http://localhost.evil.example' }),
      ).toThrow(/https in production/);
    });

    it.each([
      ['trailing slash', 'http://localhost:3000/'],
      ['path', 'https://app.ranvier.example/swap'],
      ['query', 'https://app.ranvier.example?x=1'],
      ['upper case', 'https://App.Ranvier.example'],
      ['default port', 'https://app.ranvier.example:443'],
      ['credentials', 'https://user:pw@app.ranvier.example'],
      ['wildcard', '*'],
      ['wildcard subdomain', 'https://*.ranvier.example'],
      ['null origin', 'null'],
      ['no scheme', 'app.ranvier.example'],
      ['other scheme', 'ftp://app.ranvier.example'],
      ['file scheme', 'file:///etc/passwd'],
      ['invalid URL', 'http://'],
      ['empty entry', 'http://localhost:3000,,https://app.ranvier.example'],
      ['trailing comma', 'http://localhost:3000,'],
      ['duplicate', 'http://localhost:3000, http://localhost:3000'],
    ])('refuses a %s at startup', (_label, value) => {
      expect(() => loadConfig({ WEB_ORIGINS: value })).toThrow(/WEB_ORIGINS/);
    });
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
      for (const id of [
        'my-key',
        'alias/',
        'arn:aws:kms:eu-west-1:1:key/x',
        'alias/a b',
        // Multi-Region keys are refused (ADR 0005).
        `mrk-${'a'.repeat(32)}`,
        `arn:aws:kms:eu-west-1:111122223333:key/mrk-${'a'.repeat(32)}`,
      ]) {
        expect(() => loadConfig({ KMS_KEY_ID: id, AWS_REGION: 'eu-west-1' }), id).toThrow();
      }
      for (const region of ['EU-WEST-1', 'eu-west', 'europe']) {
        expect(() => loadConfig({ KMS_KEY_ID: ARN, AWS_REGION: region }), region).toThrow();
      }
      expect(loadConfig({ AWS_REGION: 'us-gov-west-1' }).AWS_REGION).toBe('us-gov-west-1');
    });

    it('parses the expected signer address', () => {
      const expected = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7';
      expect(
        loadConfig({ KMS_EXPECTED_SIGNER_ADDRESS: expected }).KMS_EXPECTED_SIGNER_ADDRESS,
      ).toBe(expected);
      expect(() => loadConfig({ KMS_EXPECTED_SIGNER_ADDRESS: '0x1234' })).toThrow();
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

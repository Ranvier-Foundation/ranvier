import { describe, expect, it } from 'vitest';
import { padHex } from 'viem';
import { KmsSigner } from './adapters/signers/kms.js';
import { LocalKeySigner } from './adapters/signers/local-key.js';
import { loadConfig, type Config } from './config.js';
import { setUpSigning } from './signer-setup.js';
import { FAKE_ALIAS, FAKE_KEY_ARN, FakeKms } from './testing/fake-kms.js';
import { TRUSTED_ROUTERS } from './trusted-routers.js';

const KEY = padHex('0xa11ce', { size: 32 });
const WRAPPER = '0x000000000000000000000000000000000000fee1';

function deps(kms = new FakeKms({ privateKey: KEY })) {
  const regions: string[] = [];
  return {
    regions,
    kms,
    deps: {
      policy: TRUSTED_ROUTERS,
      kmsTransport: (region: string) => {
        regions.push(region);
        return kms;
      },
    },
  };
}

const kmsEnv = {
  KMS_KEY_ID: FAKE_ALIAS,
  AWS_REGION: 'eu-west-1',
  FEE_WRAPPER_ADDRESS: WRAPPER,
};

describe('setUpSigning', () => {
  it('uses the KMS signer for mainnets when KMS_KEY_ID is set', async () => {
    const d = deps();
    const setup = await setUpSigning(loadConfig(kmsEnv), d.deps);
    expect(setup?.signer).toBeInstanceOf(KmsSigner);
    expect(setup?.signer.kind).toBe('kms');
    expect(setup?.signer.address).toBe(d.kms.address);
    expect((setup?.signer as KmsSigner).keyArn).toBe(FAKE_KEY_ARN);
    expect(setup?.feeWrapper).toBe(WRAPPER);
    expect(setup?.ttlSeconds).toBe(60);
    expect(d.regions).toEqual(['eu-west-1']);
    for (const id of [1, 8453, 42161]) expect(setup?.signer.canSign(id)).toBe(true);
  });

  it('fails startup with a clear message on any KMS error', async () => {
    const kms = new FakeKms({
      privateKey: KEY,
      onDescribe: async () => {
        throw Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
      },
    });
    await expect(setUpSigning(loadConfig(kmsEnv), deps(kms).deps)).rejects.toThrow(
      'KMS signer startup failed: KMS DescribeKey failed for alias/ranvier-fee-signer-test: AccessDeniedException',
    );
    const disabled = new FakeKms({ privateKey: KEY, metadata: { KeyState: 'Disabled' } });
    await expect(setUpSigning(loadConfig(kmsEnv), deps(disabled).deps)).rejects.toThrow(
      'KMS signer startup failed: KMS key',
    );
    const odd = new FakeKms({
      privateKey: KEY,
      onDescribe: async () => {
        throw 'not an Error';
      },
    });
    await expect(setUpSigning(loadConfig(kmsEnv), deps(odd).deps)).rejects.toThrow(
      'string: not an Error',
    );
  });

  it('fails startup when a quoted chain has no trusted router policy', async () => {
    await expect(
      setUpSigning(loadConfig({ ...kmsEnv, ZEROX_CHAIN_IDS: '1,10' }), deps().deps),
    ).rejects.toThrow('chain(s) 10 without a trusted router policy');
  });

  it('needs the fee wrapper and the region', async () => {
    const noWrapper = { ...kmsEnv, FEE_WRAPPER_ADDRESS: undefined };
    await expect(setUpSigning(loadConfig(noWrapper), deps().deps)).rejects.toThrow(
      'FEE_WRAPPER_ADDRESS is not',
    );
    // loadConfig already refuses this; the setup checks again rather than assume it.
    const noRegion = { ...loadConfig(kmsEnv), AWS_REGION: undefined } as unknown as Config;
    await expect(setUpSigning(noRegion, deps().deps)).rejects.toThrow('AWS_REGION is required');
  });

  it('keeps the local-key rules unchanged: testnets only', async () => {
    const d = deps();
    const local = await setUpSigning(
      loadConfig({
        QUOTE_SIGNER_PRIVATE_KEY: KEY,
        FEE_WRAPPER_ADDRESS: WRAPPER,
        ZEROX_CHAIN_IDS: '84532',
        LOCAL_SIGNER_CHAIN_IDS: '84532',
      }),
      d.deps,
    );
    expect(local?.signer).toBeInstanceOf(LocalKeySigner);
    expect(local?.signer.kind).toBe('local-key');
    expect(local?.signer.canSign(84532)).toBe(true);
    expect(local?.signer.canSign(31337)).toBe(false);
    expect(d.regions).toEqual([]); // KMS never touched

    const defaults = await setUpSigning(
      loadConfig({
        QUOTE_SIGNER_PRIVATE_KEY: KEY,
        FEE_WRAPPER_ADDRESS: WRAPPER,
        ZEROX_CHAIN_IDS: '31337',
      }),
      d.deps,
    );
    expect(defaults?.signer.canSign(31337)).toBe(true);

    await expect(
      setUpSigning(
        loadConfig({ QUOTE_SIGNER_PRIVATE_KEY: KEY, FEE_WRAPPER_ADDRESS: WRAPPER }),
        d.deps,
      ),
    ).rejects.toThrow('ZEROX_CHAIN_IDS includes chain(s) 1, 8453, 42161');
  });

  it('returns no signer when none is configured', async () => {
    expect(await setUpSigning(loadConfig({}), deps().deps)).toBeUndefined();
    expect(
      await setUpSigning(loadConfig({ QUOTE_SIGNER_PRIVATE_KEY: KEY }), deps().deps),
    ).toBeUndefined();
  });
});

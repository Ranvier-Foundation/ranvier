/**
 * ADR 0013, section 4: the production published-address guard, with the PUBLIC anvil keys
 * themselves (chain 31337 only, derived in memory from the published mnemonic; never printed).
 * They live here, next to the harness, because production sources and their tests hold
 * addresses only (`src/published-addresses.ts`).
 */
import { padHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { KmsSigner } from '../../src/adapters/signers/kms.js';
import { loadConfig } from '../../src/config.js';
import { PUBLISHED_MNEMONIC_ACCOUNTS } from '../../src/published-addresses.js';
import { setUpSigning } from '../../src/signer-setup.js';
import { FAKE_KEY_ARN, FakeKms } from '../../src/testing/fake-kms.js';
import { TRUSTED_ROUTERS } from '../../src/trusted-routers.js';
import { anvilAccount, publicAnvilKey } from '../../src/harness/dev-accounts.js';

const WRAPPER = '0x000000000000000000000000000000000000fee1';

describe('the TS list is the published mnemonic, derived', () => {
  it('accounts 0..29 of the published mnemonic, in order', () => {
    const derived = Array.from({ length: 30 }, (_, i) => anvilAccount(i).address.toLowerCase());
    expect(PUBLISHED_MNEMONIC_ACCOUNTS).toEqual(derived);
  }, 60_000); // 30 seed derivations (PBKDF2), slow under coverage
});

function deps(kms?: FakeKms) {
  const regions: string[] = [];
  return {
    regions,
    deps: {
      nodeEnv: 'test' as string | undefined,
      policy: TRUSTED_ROUTERS,
      kmsTransport: (region: string) => {
        regions.push(region);
        if (!kms) throw new Error('no KMS in this test');
        return kms;
      },
    },
  };
}

describe('setUpSigning refuses a published signer off 31337', () => {
  // Accounts 0, 1 and 29: the first, the harness fee signer and the last listed.
  it.each([0, 1, 29])('local key of anvil account %i', { timeout: 30_000 }, async (index) => {
    // PUBLIC anvil key, chain 31337 only.
    const key = publicAnvilKey(anvilAccount(index));
    for (const chains of ['84532', '11155111', '421614', '84532,31337']) {
      await expect(
        setUpSigning(
          loadConfig({
            QUOTE_SIGNER_PRIVATE_KEY: key,
            FEE_WRAPPER_ADDRESS: WRAPPER,
            ZEROX_CHAIN_IDS: chains,
          }),
          deps().deps,
        ),
      ).rejects.toThrow(/^The local signing key address is 0x[0-9a-fA-F]{40}, a published/);
    }
    // Every quoted chain 31337: accepted (the harness case).
    const setup = await setUpSigning(
      loadConfig({
        QUOTE_SIGNER_PRIVATE_KEY: key,
        FEE_WRAPPER_ADDRESS: WRAPPER,
        ZEROX_CHAIN_IDS: '31337',
      }),
      deps().deps,
    );
    expect(setup?.signer.address).toBe(anvilAccount(index).address);
  });

  it('a KMS key whose material is a published key (imported), with no expected address', async () => {
    // PUBLIC anvil key, chain 31337 only: stands in for imported key material.
    const kms = new FakeKms({ privateKey: publicAnvilKey(anvilAccount(1)) });
    const config = loadConfig({
      KMS_KEY_ID: FAKE_KEY_ARN,
      AWS_REGION: 'eu-west-1',
      FEE_WRAPPER_ADDRESS: WRAPPER,
      ZEROX_CHAIN_IDS: '84532',
    });
    const testnetPolicy = new Map([[84532, TRUSTED_ROUTERS.get(1) ?? []]]);
    await expect(
      setUpSigning(config, { ...deps(kms).deps, policy: testnetPolicy }),
    ).rejects.toThrow(
      /^The KMS key address is 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, a published/,
    );
  });

  it('a KMS key with ordinary material still starts (control)', async () => {
    const kms = new FakeKms({ privateKey: padHex('0xa11ce', { size: 32 }) });
    const config = loadConfig({
      KMS_KEY_ID: FAKE_KEY_ARN,
      AWS_REGION: 'eu-west-1',
      FEE_WRAPPER_ADDRESS: WRAPPER,
      ZEROX_CHAIN_IDS: '84532',
    });
    const testnetPolicy = new Map([[84532, TRUSTED_ROUTERS.get(1) ?? []]]);
    const setup = await setUpSigning(config, { ...deps(kms).deps, policy: testnetPolicy });
    expect(setup?.signer).toBeInstanceOf(KmsSigner);
  });
});

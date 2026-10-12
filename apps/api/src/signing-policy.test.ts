import { describe, expect, it } from 'vitest';
import { padHex, type Hex } from 'viem';
import { KmsSigner } from './adapters/signers/kms.js';
import { LocalKeySigner } from './adapters/signers/local-key.js';
import { buildRoutePolicy } from './domain/route-policy.js';
import type { QuoteSigner, SignerKind } from './ports/quote-signer.js';
import { assertKmsSigningChains, canSignChain } from './signing-policy.js';
import { FAKE_ALIAS, FakeKms } from './testing/fake-kms.js';
import { TRUSTED_ROUTERS } from './trusted-routers.js';

const KEY = padHex('0xa11ce', { size: 32 });
const ROUTER = {
  kind: 'zerox-allowance-holder' as const,
  address: '0x0000000000001ff3684f28c67538d4d072c22734',
  targets: [`0x${'11'.repeat(20)}`],
};
// Mainnets 1 and 8453 plus testnet 84532 have routers; 42161 and 11155111 do not.
const POLICY = buildRoutePolicy({ 1: [ROUTER], 8453: [ROUTER], 84532: [ROUTER], 42161: [] });

/** A signer that claims it can sign anything: the gate must not rely on its honesty. */
function claims(kind: SignerKind): QuoteSigner {
  return {
    kind,
    address: `0x${'aa'.repeat(20)}` as Hex,
    canSign: () => true,
    signTypedData: async () => '0x',
  };
}

const kmsSigner = (chainIds: number[]) =>
  KmsSigner.create({ keyId: FAKE_ALIAS, transport: new FakeKms({ privateKey: KEY }), chainIds });

describe('canSignChain', () => {
  it('local key: testnets with a router policy only, never a mainnet', () => {
    const local = new LocalKeySigner(KEY, { nodeEnv: 'test' });
    expect(canSignChain(local, POLICY, 84532)).toBe(true);
    expect(canSignChain(local, POLICY, 11155111)).toBe(false); // no router policy
    for (const id of [1, 8453, 42161, 10]) expect(canSignChain(local, POLICY, id)).toBe(false);
  });

  it('a local-key signer is refused mainnets even if its canSign says yes', () => {
    const rogue = claims('local-key');
    for (const id of [1, 8453]) expect(canSignChain(rogue, POLICY, id), String(id)).toBe(false);
    expect(canSignChain(rogue, POLICY, 84532)).toBe(true);
  });

  it('KMS key: its configured chains, and only those with a router policy', async () => {
    const kms = await kmsSigner([1, 42161, 10]);
    expect(canSignChain(kms, POLICY, 1)).toBe(true);
    expect(canSignChain(kms, POLICY, 8453)).toBe(false); // not configured
    expect(canSignChain(kms, POLICY, 42161)).toBe(false); // empty router list
    expect(canSignChain(kms, POLICY, 10)).toBe(false); // no router policy
  });

  it('even a KMS signer that claims everything needs a router policy', () => {
    const kms = claims('kms');
    expect(canSignChain(kms, POLICY, 1)).toBe(true);
    expect(canSignChain(kms, POLICY, 137)).toBe(false);
    expect(canSignChain(kms, POLICY, 11155111)).toBe(false);
  });

  it('the production policy allows exactly the trusted router chains for KMS', async () => {
    const kms = await kmsSigner([1, 8453, 42161, 10, 137]);
    const allowed = [1, 8453, 42161, 10, 137].filter((id) =>
      canSignChain(kms, TRUSTED_ROUTERS, id),
    );
    expect(allowed).toEqual([...TRUSTED_ROUTERS.keys()].sort((a, b) => a - b));
  });
});

describe('assertKmsSigningChains', () => {
  it('passes when every quoted chain is signable', async () => {
    const kms = await kmsSigner([1, 8453]);
    expect(() => assertKmsSigningChains([1, 8453], kms, POLICY)).not.toThrow();
  });

  it('names chains without a trusted router policy', async () => {
    const kms = await kmsSigner([1, 10, 42161]);
    expect(() => assertKmsSigningChains([1, 10, 42161], kms, POLICY)).toThrow(
      'ZEROX_CHAIN_IDS includes chain(s) 10, 42161 without a trusted router policy',
    );
  });

  it('refuses a non-KMS signer', () => {
    const local = new LocalKeySigner(KEY, { nodeEnv: 'test' });
    expect(() => assertKmsSigningChains([84532], local, POLICY)).toThrow('needs a KMS signer');
  });
});

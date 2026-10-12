import { describe, expect, it } from 'vitest';
import { hashTypedData, padHex } from 'viem';
import { SignCommand } from '@aws-sdk/client-kms';
import { runKmsSmoke, SMOKE_CHAIN_ID, SMOKE_TYPED_DATA } from './kms-smoke.js';
import { EIP712_NAME } from './domain/swap-quote.js';
import { FAKE_ALIAS, FAKE_KEY_ARN, FakeKms } from './testing/fake-kms.js';

const KEY = padHex('0xa11ce', { size: 32 });

async function run(kms: FakeKms) {
  const lines: string[] = [];
  const passed = await runKmsSmoke({
    keyId: FAKE_ALIAS,
    transport: kms,
    print: (l) => lines.push(l),
  });
  return { passed, out: lines.join('\n') };
}

describe('runKmsSmoke', () => {
  it('signs only the labelled test message for chain 31337, never a quote', () => {
    expect(SMOKE_CHAIN_ID).toBe(31337);
    expect(SMOKE_TYPED_DATA.domain.name).not.toBe(EIP712_NAME);
    expect(SMOKE_TYPED_DATA.primaryType).not.toBe('SwapQuote');
    expect(SMOKE_TYPED_DATA.message.purpose).toContain('not a swap quote');
  });

  it('prints the key, the address and PASS', async () => {
    const kms = new FakeKms({ privateKey: KEY });
    const { passed, out } = await run(kms);
    expect(passed).toBe(true);
    expect(out).toContain(`key ARN:   ${FAKE_KEY_ARN}`);
    expect(out).toContain('ECC_SECG_P256K1 / SIGN_VERIFY / Enabled / origin AWS_KMS');
    expect(out).toContain(`address:   ${kms.address}`);
    expect(out).toContain(`recovered: ${kms.address}`);
    expect(out).toContain(hashTypedData(SMOKE_TYPED_DATA));
    expect(out).toMatch(/PASS/);
    const sign = kms.calls.find((c) => c instanceof SignCommand);
    expect(sign?.input.Message).toEqual(
      Uint8Array.from(Buffer.from(hashTypedData(SMOKE_TYPED_DATA).slice(2), 'hex')),
    );
  });

  it('prints FAIL when the key is refused', async () => {
    const { passed, out } = await run(
      new FakeKms({ privateKey: KEY, metadata: { KeySpec: 'ECC_NIST_P256' } }),
    );
    expect(passed).toBe(false);
    expect(out).toMatch(/^FAIL: KMS key .* refused: KeySpec is ECC_NIST_P256$/);
  });

  it('prints FAIL when signing fails', async () => {
    const { passed, out } = await run(
      new FakeKms({
        privateKey: KEY,
        onSign: async () => {
          throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
        },
      }),
    );
    expect(passed).toBe(false);
    expect(out).toContain('FAIL: KMS Sign failed: AccessDeniedException');
    expect(out).not.toContain('PASS');
  });

  it('prints FAIL for non-Error failures', async () => {
    const startup = await run(
      new FakeKms({
        privateKey: KEY,
        onDescribe: async () => {
          throw 'boom';
        },
      }),
    );
    expect(startup.out).toContain('FAIL: KMS DescribeKey failed');
  });
});

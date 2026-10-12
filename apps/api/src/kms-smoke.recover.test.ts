import { describe, expect, it, vi } from 'vitest';
import type * as Viem from 'viem';
import { padHex } from 'viem';
import { runKmsSmoke } from './kms-smoke.js';
import { FAKE_ALIAS, FakeKms } from './testing/fake-kms.js';

// The smoke test re-checks the signature with viem's typed-data recovery, independently of
// the signer's own check. Simulate that check disagreeing, and a non-Error throw from it.
let mode: 'wrong' | 'throw' = 'wrong';
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof Viem>();
  return {
    ...actual,
    recoverTypedDataAddress: async () => {
      if (mode === 'throw') throw 42;
      return '0x000000000000000000000000000000000000dEaD';
    },
  };
});

describe('runKmsSmoke independent check', () => {
  const kms = () => new FakeKms({ privateKey: padHex('0xa11ce', { size: 32 }) });

  it('prints FAIL when the signature recovers to another address', async () => {
    const lines: string[] = [];
    mode = 'wrong';
    const passed = await runKmsSmoke({
      keyId: FAKE_ALIAS,
      transport: kms(),
      print: (l) => lines.push(l),
    });
    expect(passed).toBe(false);
    expect(lines).toContain('FAIL: the signature recovers to a different address');
  });

  it('prints FAIL when the check throws', async () => {
    const lines: string[] = [];
    mode = 'throw';
    const passed = await runKmsSmoke({
      keyId: FAKE_ALIAS,
      transport: kms(),
      print: (l) => lines.push(l),
    });
    expect(passed).toBe(false);
    expect(lines).toContain('FAIL: 42');
  });
});

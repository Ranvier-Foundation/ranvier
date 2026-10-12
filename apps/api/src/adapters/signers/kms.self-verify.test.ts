import { describe, expect, it, vi } from 'vitest';
import type * as Ecdsa from './ecdsa.js';
import { keccak256, padHex } from 'viem';
import { typedData } from '../../domain/swap-quote.js';
import { FAKE_ALIAS, FakeKms } from '../../testing/fake-kms.js';
import { KmsSigner } from './kms.js';

// Simulates a bug in the DER-to-Ethereum conversion: it returns a well-formed signature that
// does not verify. The signer's independent final check must refuse it.
vi.mock('./ecdsa.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Ecdsa>();
  return {
    ...actual,
    toEthereumSignature: async () => `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as const,
  };
});

describe('KmsSigner self-verification', () => {
  it('never returns a signature that does not recover to the signer', async () => {
    const signer = await KmsSigner.create({
      keyId: FAKE_ALIAS,
      transport: new FakeKms({ privateKey: padHex('0xa11ce', { size: 32 }) }),
      chainIds: [1],
    });
    const quote = typedData(
      {
        user: '0x00000000000000000000000000000000000000aa',
        tokenIn: '0x00000000000000000000000000000000000000b1',
        tokenOut: '0x00000000000000000000000000000000000000c2',
        amountIn: 1n,
        minAmountOut: 1n,
        feeAmount: 0n,
        router: '0x0000000000001fF3684f28c67538d4D072C22734',
        routerCalldataHash: keccak256('0x'),
        nonce: 1n,
        deadline: 1n,
      },
      1,
      '0x000000000000000000000000000000000000fee1',
    );
    await expect(signer.signTypedData(quote)).rejects.toMatchObject({
      name: 'SigningUnavailableError',
      reason: 'integrity',
      message: 'KMS signature failed self-verification',
    });
  });
});

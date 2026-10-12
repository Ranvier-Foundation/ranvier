import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  SignCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';
import {
  bytesToHex,
  hashTypedData,
  hexToBytes,
  keccak256,
  padHex,
  recoverTypedDataAddress,
  serializeSignature,
  type Hex,
} from 'viem';
import { sign } from 'viem/accounts';
import { typedData, type SwapQuote } from '../../domain/swap-quote.js';
import { SigningUnavailableError } from '../../ports/quote-signer.js';
import {
  derSignature,
  FAKE_ALIAS,
  FAKE_KEY_ARN,
  FakeKms,
  rawSign,
  type FakeKmsOptions,
} from '../../testing/fake-kms.js';
import { SECP256K1_HALF_N } from './ecdsa.js';
import { awsKmsTransport, isRetryable, KmsSigner, type KmsSignerOptions } from './kms.js';

/**
 * Golden values shared with contracts/test/QuoteSigningCompat.t.sol and
 * src/domain/swap-quote.test.ts (copied, not changed): the same key behind a fake KMS must
 * produce the exact signature the contract test accepts.
 */
const GOLDEN = {
  wrapper: '0x000000000000000000000000000000000000fee1',
  signer: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7',
  digest: '0xc5c18c006aa73b004031c786d634987179d5325425f6632c4350925c89a0e276',
  signature:
    '0xe2b5fbde8e1861cd293e88340c35d39d0b498d7336cf651f504df0c242c99cd83f0cc31e6cb7edc8b3a86f47475b9f9ad441a104a51baba96992e80d5e47c1d81b',
} as const;

const goldenQuote: SwapQuote = {
  user: '0x00000000000000000000000000000000000000aa',
  tokenIn: '0x00000000000000000000000000000000000000b1',
  tokenOut: '0x00000000000000000000000000000000000000c2',
  amountIn: 1_000_000_000n,
  minAmountOut: 10n ** 18n,
  feeAmount: 1_234_567n,
  router: '0x0000000000001fF3684f28c67538d4D072C22734',
  routerCalldataHash: keccak256('0x1234'),
  nonce: 42n,
  deadline: 1_800_000_000n,
};

const KEY = padHex('0xa11ce', { size: 32 });
const OTHER_KEY = padHex('0xb0b', { size: 32 });

const fake = (opts: Partial<FakeKmsOptions> = {}) => new FakeKms({ privateKey: KEY, ...opts });

const create = (kms: FakeKms, opts: Partial<KmsSignerOptions> = {}) =>
  KmsSigner.create({
    keyId: FAKE_ALIAS,
    transport: kms,
    chainIds: [1, 8453, 31337],
    retryDelayMs: 1,
    ...opts,
  });

const quoteOn = (chainId: number, nonce = 42n) =>
  typedData({ ...goldenQuote, nonce }, chainId, GOLDEN.wrapper);

/** An AWS-SDK-shaped service error. */
function awsError(name: string, fault: 'client' | 'server' = 'client'): Error {
  return Object.assign(new Error(`${name}: details from AWS`), { name, $fault: fault });
}

const unavailable = (reason: string) =>
  expect.objectContaining({ name: 'SigningUnavailableError', reason });

afterEach(() => {
  vi.useRealTimers();
});

/** What the real fake KMS answers for this Sign input: a valid DER signature by KEY. */
async function validSignResponse(input: SignCommand['input']) {
  const raw = await rawSign(KEY, bytesToHex(input.Message ?? new Uint8Array()), true);
  return {
    KeyId: FAKE_KEY_ARN,
    Signature: derSignature(raw.r, raw.s),
    SigningAlgorithm: 'ECDSA_SHA_256',
  };
}

describe('validSignResponse (control for the fail-closed cases)', () => {
  it('is accepted when nothing is changed', async () => {
    const signer = await create(fake({ onSign: validSignResponse }));
    await expect(signer.signTypedData(quoteOn(31337))).resolves.toBe(GOLDEN.signature);
  });
});

describe('KmsSigner.create', () => {
  it('resolves the key, checks it and derives the address from the public key', async () => {
    const kms = fake();
    const signer = await create(kms);
    expect(signer.kind).toBe('kms');
    expect(signer.address).toBe(GOLDEN.signer);
    expect(signer.keyArn).toBe(FAKE_KEY_ARN);
    expect(signer.info).toEqual({
      keyArn: FAKE_KEY_ARN,
      address: GOLDEN.signer,
      keySpec: 'ECC_SECG_P256K1',
      keyUsage: 'SIGN_VERIFY',
      keyState: 'Enabled',
      origin: 'AWS_KMS',
    });
    expect(kms.calls).toHaveLength(2);
    expect(kms.calls[0]).toBeInstanceOf(DescribeKeyCommand);
    expect(kms.calls[0]?.input).toEqual({ KeyId: FAKE_ALIAS });
    // After DescribeKey everything uses the resolved ARN, never the alias.
    expect(kms.calls[1]).toBeInstanceOf(GetPublicKeyCommand);
    expect(kms.calls[1]?.input).toEqual({ KeyId: FAKE_KEY_ARN });
  });

  it('accepts a CloudHSM key store key', async () => {
    const signer = await create(fake({ metadata: { Origin: 'AWS_CLOUDHSM' } }));
    expect(signer.info.origin).toBe('AWS_CLOUDHSM');
  });

  const refusals: [string, Partial<FakeKmsOptions>, string][] = [
    ['a disabled key', { metadata: { KeyState: 'Disabled' } }, 'KeyState is Disabled'],
    [
      'a key pending deletion',
      { metadata: { KeyState: 'PendingDeletion' } },
      'KeyState is PendingDeletion',
    ],
    ['a P-256 key', { metadata: { KeySpec: 'ECC_NIST_P256' } }, 'KeySpec is ECC_NIST_P256'],
    [
      'an encryption key',
      { metadata: { KeyUsage: 'ENCRYPT_DECRYPT' } },
      'KeyUsage is ENCRYPT_DECRYPT',
    ],
    ['an AWS managed key', { metadata: { KeyManager: 'AWS' } }, 'KeyManager is AWS'],
    ['a multi-Region key', { metadata: { MultiRegion: true } }, 'MultiRegion is true'],
    [
      'a key that does not report MultiRegion',
      { metadata: { MultiRegion: undefined } },
      'MultiRegion is undefined',
    ],
    ['imported key material', { metadata: { Origin: 'EXTERNAL' } }, 'Origin is EXTERNAL'],
    [
      'an external key store',
      { metadata: { Origin: 'EXTERNAL_KEY_STORE' } },
      'Origin is EXTERNAL_KEY_STORE',
    ],
    ['a key without an origin', { metadata: { Origin: undefined } }, 'Origin is undefined'],
    [
      'a key without ECDSA_SHA_256',
      { metadata: { SigningAlgorithms: ['ECDSA_SHA_384'] } },
      'ECDSA_SHA_256 is not supported',
    ],
    [
      'a key without signing algorithms',
      { metadata: { SigningAlgorithms: undefined } },
      'ECDSA_SHA_256 is not supported',
    ],
    ['a missing state', { metadata: { KeyState: undefined } }, 'KeyState is undefined'],
    [
      'a public key for another key',
      { publicKey: { KeyId: `${FAKE_KEY_ARN}0` } },
      'answered for a different key',
    ],
    [
      'a public key with another spec',
      { publicKey: { KeySpec: 'ECC_NIST_P256' } },
      'different KeySpec or KeyUsage',
    ],
    [
      'a public key with another usage',
      { publicKey: { KeyUsage: 'KEY_AGREEMENT' } },
      'different KeySpec or KeyUsage',
    ],
    [
      'a public key that is not secp256k1',
      { publicKey: { PublicKey: new Uint8Array(91) } },
      'not an uncompressed secp256k1 SPKI',
    ],
    [
      'a malformed DescribeKey response',
      { onDescribe: async () => ({ KeyMetadata: { Arn: 'not-an-arn' } }) },
      'DescribeKey returned an unexpected response',
    ],
    [
      'a malformed GetPublicKey response',
      { publicKey: { PublicKey: 'base64?' } },
      'GetPublicKey returned an unexpected response',
    ],
  ];
  for (const [name, opts, message] of refusals) {
    it(`refuses ${name}`, async () => {
      await expect(create(fake(opts))).rejects.toThrow(message);
    });
  }

  it('names the key, never the credentials, when KMS refuses', async () => {
    const kms = fake({
      onDescribe: async () => {
        throw awsError('AccessDeniedException');
      },
    });
    await expect(create(kms)).rejects.toThrow(
      `KMS DescribeKey failed for ${FAKE_ALIAS}: AccessDeniedException`,
    );
    expect(kms.calls).toHaveLength(1); // access denied is never retried
  });

  it('retries a throttled startup call once', async () => {
    let calls = 0;
    const kms = fake({
      onGetPublicKey: async () => {
        calls++;
        throw awsError('ThrottlingException');
      },
    });
    await expect(create(kms)).rejects.toThrow('GetPublicKey failed');
    expect(calls).toBe(2);
  });

  it('validates its options', async () => {
    await expect(create(fake(), { keyId: ' ' })).rejects.toThrow('key ID is empty');
    await expect(create(fake(), { chainIds: [] })).rejects.toThrow('at least one valid chain');
    await expect(create(fake(), { chainIds: [0] })).rejects.toThrow('at least one valid chain');
    await expect(create(fake(), { timeoutMs: 0 })).rejects.toThrow('timeoutMs');
    await expect(create(fake(), { startupTimeoutMs: 1.5 })).rejects.toThrow('startupTimeoutMs');
    await expect(create(fake(), { maxInFlight: 0 })).rejects.toThrow('maxInFlight');
    await expect(create(fake(), { maxQueue: -1 })).rejects.toThrow('maxQueue');
  });
});

describe('KmsSigner.signTypedData', () => {
  it('produces the golden signature the FeeWrapper test accepts (fake KMS, same key)', async () => {
    for (const sMode of ['high', 'low'] as const) {
      const signer = await create(fake({ sMode }));
      const data = quoteOn(31337);
      expect(hashTypedData(data)).toBe(GOLDEN.digest);
      expect(await signer.signTypedData(data)).toBe(GOLDEN.signature);
      const recovered = await recoverTypedDataAddress({
        ...data,
        signature: GOLDEN.signature,
      } as Parameters<typeof recoverTypedDataAddress>[0]);
      expect(recovered).toBe(GOLDEN.signer);
    }
  });

  it('calls Sign with the ARN, the 32-byte EIP-712 digest, DIGEST and ECDSA_SHA_256', async () => {
    const kms = fake();
    const signer = await create(kms);
    const data = quoteOn(8453);
    await signer.signTypedData(data);
    const call = kms.calls[2];
    expect(call).toBeInstanceOf(SignCommand);
    expect(call?.input).toEqual({
      KeyId: FAKE_KEY_ARN,
      Message: hexToBytes(hashTypedData(data)),
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    });
  });

  it('normalises high s, pads DER integers and finds the recovery bit (fuzzed)', async () => {
    // Find quotes whose signatures exercise every DER and recovery case.
    const want = { highR: false, shortR: false, shortS: false, v27: false, v28: false };
    const nonces: bigint[] = [];
    for (let n = 0n; n < 4_000n && !Object.values(want).every(Boolean); n++) {
      const digest = hashTypedData(quoteOn(1, n));
      const sig = await sign({ hash: digest, privateKey: KEY });
      const r = BigInt(sig.r);
      const s = BigInt(sig.s);
      const hit = {
        highR: r >> 255n === 1n && !want.highR,
        shortR: r < 1n << 248n && !want.shortR,
        shortS: s < 1n << 248n && !want.shortS,
        v27: sig.yParity === 0 && !want.v27,
        v28: sig.yParity === 1 && !want.v28,
      };
      if (Object.values(hit).some(Boolean) || n < 16n) {
        nonces.push(n);
        for (const [k, v] of Object.entries(hit)) if (v) want[k as keyof typeof want] = true;
      }
    }
    expect(want).toEqual({ highR: true, shortR: true, shortS: true, v27: true, v28: true });

    const signer = await create(fake({ sMode: 'alternate' }));
    for (const n of nonces) {
      const data = quoteOn(1, n);
      const sig = await signer.signTypedData(data);
      expect(sig).toBe(
        serializeSignature(await sign({ hash: hashTypedData(data), privateKey: KEY })),
      );
      expect(BigInt(`0x${sig.slice(66, 130)}`) <= SECP256K1_HALF_N).toBe(true);
      expect(['1b', '1c']).toContain(sig.slice(-2));
    }
  });

  it('signs only for its configured chains', async () => {
    const signer = await create(fake(), { chainIds: [8453] });
    expect(signer.canSign(8453)).toBe(true);
    expect(signer.canSign(1)).toBe(false);
    await expect(signer.signTypedData(quoteOn(1))).rejects.toThrow('KmsSigner refuses chain 1');
    const noChain = { ...quoteOn(8453), domain: { name: 'Ranvier FeeWrapper' } };
    await expect(signer.signTypedData(noChain)).rejects.toThrow('refuses chain undefined');
  });

  describe('fails closed', () => {
    const cases: [string, FakeKmsOptions['onSign']][] = [
      [
        'a signature from another key',
        async (input) => {
          const raw = await rawSign(
            OTHER_KEY,
            bytesToHex(input.Message ?? new Uint8Array()),
            false,
          );
          return {
            KeyId: FAKE_KEY_ARN,
            Signature: derSignature(raw.r, raw.s),
            SigningAlgorithm: 'ECDSA_SHA_256',
          };
        },
      ],
      [
        'garbage instead of DER',
        async () => ({
          KeyId: FAKE_KEY_ARN,
          Signature: new Uint8Array(70).fill(0x30),
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      ],
      // A valid signature by the right key over the right digest, with only one response field
      // changed: these pass only because of the KeyId and algorithm checks in kms.ts.
      [
        'a response for another key',
        async (input) => ({
          ...(await validSignResponse(input)),
          KeyId: 'arn:aws:kms:eu-west-1:111122223333:key/00000000-0000-0000-0000-000000000000',
        }),
      ],
      [
        'another algorithm',
        async (input) => ({
          ...(await validSignResponse(input)),
          SigningAlgorithm: 'ECDSA_SHA_384',
        }),
      ],
      ['a malformed response', async () => ({ KeyId: FAKE_KEY_ARN, Signature: 'AAAA' })],
    ];
    for (const [name, onSign] of cases) {
      it(`on ${name}`, async () => {
        const signer = await create(fake(onSign ? { onSign } : {}));
        await expect(signer.signTypedData(quoteOn(31337))).rejects.toEqual(
          unavailable('integrity'),
        );
      });
    }
  });

  describe('bounded retries and timeouts', () => {
    it('does not retry access denied, a disabled key or an invalid key', async () => {
      for (const name of [
        'AccessDeniedException',
        'DisabledException',
        'InvalidKeyUsageException',
        'KMSInvalidStateException',
        'NotFoundException',
      ]) {
        let calls = 0;
        const signer = await create(
          fake({
            onSign: async () => {
              calls++;
              throw awsError(name);
            },
          }),
        );
        const err = await signer.signTypedData(quoteOn(1)).catch((e: unknown) => e);
        expect(err, name).toEqual(unavailable('upstream'));
        expect(err).toBeInstanceOf(SigningUnavailableError);
        expect((err as Error).message).toContain(name);
        expect(calls, name).toBe(1);
      }
    });

    it('retries throttling once, then gives up', async () => {
      let calls = 0;
      const signer = await create(
        fake({
          onSign: async () => {
            calls++;
            throw awsError('ThrottlingException');
          },
        }),
      );
      await expect(signer.signTypedData(quoteOn(1))).rejects.toEqual(unavailable('upstream'));
      expect(calls).toBe(2);
    });

    it('succeeds when the single retry succeeds', async () => {
      const base = fake();
      let calls = 0;
      const kms = fake({
        onSign: async (input, signal) => {
          calls++;
          if (calls === 1) throw awsError('KMSInternalException', 'server');
          return base.send(new SignCommand(input), { abortSignal: signal });
        },
      });
      const signer = await create(kms);
      await expect(signer.signTypedData(quoteOn(31337))).resolves.toBe(GOLDEN.signature);
      expect(calls).toBe(2);
    });

    it('times out each attempt, aborts it, retries once and reports a timeout', async () => {
      vi.useFakeTimers();
      const kms = fake({ onSign: () => new Promise(() => {}) });
      const signer = await create(kms, { timeoutMs: 2_000, retryDelayMs: 100 });
      const result = signer.signTypedData(quoteOn(1));
      const assertion = expect(result).rejects.toEqual(unavailable('timeout'));
      await vi.advanceTimersByTimeAsync(2_000 + 100 + 2_000);
      await assertion;
      const signSignals = kms.signals.slice(2);
      expect(signSignals).toHaveLength(2);
      expect(signSignals.every((s) => s.aborted)).toBe(true);
    });

    it('fails fast with busy when the in-flight limit and queue are full', async () => {
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const base = fake();
      const kms = fake({
        onSign: async (input, signal) => {
          await gate;
          return base.send(new SignCommand(input), { abortSignal: signal });
        },
      });
      const signer = await create(kms, { maxInFlight: 2, maxQueue: 1 });
      const first = [
        signer.signTypedData(quoteOn(31337)),
        signer.signTypedData(quoteOn(1)),
        signer.signTypedData(quoteOn(8453)),
      ];
      await expect(signer.signTypedData(quoteOn(1, 7n))).rejects.toEqual(unavailable('busy'));
      release();
      const sigs = await Promise.all(first);
      expect(sigs[0]).toBe(GOLDEN.signature);
      // Only the admitted calls reached KMS.
      expect(kms.calls.filter((c) => c instanceof SignCommand)).toHaveLength(3);
    });

    it('reports busy when a queued call waits longer than the timeout', async () => {
      vi.useFakeTimers();
      const kms = fake({ onSign: () => new Promise(() => {}) });
      const signer = await create(kms, { maxInFlight: 1, maxQueue: 4, timeoutMs: 1_000 });
      const stuck = signer.signTypedData(quoteOn(1)).catch((e: unknown) => e);
      const queued = expect(signer.signTypedData(quoteOn(8453))).rejects.toEqual(
        unavailable('busy'),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await queued;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await stuck).toEqual(unavailable('timeout'));
    });

    it('wraps non-Error failures', async () => {
      const signer = await create(
        fake({
          onSign: async () => {
            throw 'socket hang up';
          },
        }),
      );
      const err = await signer.signTypedData(quoteOn(1)).catch((e: unknown) => e);
      expect(err).toEqual(unavailable('upstream'));
      expect((err as Error).message).toContain('string: socket hang up');
    });
  });
});

describe('isRetryable', () => {
  it('retries throttling and transient faults only', () => {
    for (const name of [
      'ThrottlingException',
      'DependencyTimeoutException',
      'KMSInternalException',
      'KeyUnavailableException',
      'KmsTimeoutError',
      'TimeoutError',
    ]) {
      expect(isRetryable(awsError(name)), name).toBe(true);
    }
    expect(isRetryable(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(awsError('SomethingNew', 'server'))).toBe(true);
    expect(isRetryable(awsError('SomethingNew', 'client'))).toBe(false);
    expect(isRetryable(awsError('AccessDeniedException', 'server'))).toBe(false);
    expect(isRetryable(awsError('CredentialsProviderError'))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable(Object.assign(new Error('x'), { code: 42 }))).toBe(false);
    expect(isRetryable({ name: 7 })).toBe(false);
    expect(isRetryable('ThrottlingException')).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe('awsKmsTransport', () => {
  it('passes each command and the abort signal to the SDK client', async () => {
    const seen: unknown[] = [];
    const client = {
      send: async (command: unknown, options: unknown) => {
        seen.push(command, options);
        return { ok: true };
      },
    } as unknown as Pick<KMSClient, 'send'>;
    const transport = awsKmsTransport(client);
    const signal = new AbortController().signal;
    const commands = [
      new DescribeKeyCommand({ KeyId: FAKE_ALIAS }),
      new GetPublicKeyCommand({ KeyId: FAKE_KEY_ARN }),
      new SignCommand({
        KeyId: FAKE_KEY_ARN,
        Message: new Uint8Array(32),
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256',
      }),
    ];
    for (const command of commands) {
      await expect(transport.send(command, { abortSignal: signal })).resolves.toEqual({ ok: true });
    }
    expect(seen).toEqual(commands.flatMap((c) => [c, { abortSignal: signal }]));
  });
});

describe('typed data for other chains', () => {
  it('binds the signature to the chain ID', async () => {
    const signer = await create(fake());
    const a = await signer.signTypedData(quoteOn(1));
    const b = await signer.signTypedData(quoteOn(8453));
    expect(a).not.toBe(b);
    const recovered = await recoverTypedDataAddress({
      ...quoteOn(8453),
      signature: b,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered).toBe(signer.address);
    expect(typeof (a satisfies Hex)).toBe('string');
  });
});

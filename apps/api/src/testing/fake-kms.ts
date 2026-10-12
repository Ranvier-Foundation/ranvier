import { DescribeKeyCommand, GetPublicKeyCommand, type SignCommand } from '@aws-sdk/client-kms';
import { createPublicKey } from 'node:crypto';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import type { KmsCommand, KmsTransport } from '../adapters/signers/kms.js';

/** secp256k1 group order, written out here independently of the code under test. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const FAKE_KEY_ARN =
  'arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
export const FAKE_ALIAS = 'alias/ranvier-fee-signer-test';

/** Minimal DER INTEGER: strip leading zeros, then add 0x00 if the top bit is set. */
export function derInteger(v: bigint): number[] {
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let b = [...Buffer.from(hex, 'hex')];
  if ((b[0] ?? 0) & 0x80) b = [0, ...b];
  return [0x02, b.length, ...b];
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }`, as KMS returns for ECDSA. */
export function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = [...derInteger(r), ...derInteger(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** SubjectPublicKeyInfo DER built by Node's OpenSSL, independent of `parseSecp256k1Spki`. */
export function spkiFor(privateKey: Hex): Uint8Array {
  const pub = hexToBytes(privateKeyToAccount(privateKey).publicKey);
  const jwk = {
    kty: 'EC',
    crv: 'secp256k1',
    x: Buffer.from(pub.subarray(1, 33)).toString('base64url'),
    y: Buffer.from(pub.subarray(33, 65)).toString('base64url'),
  };
  return new Uint8Array(
    createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' }),
  );
}

/** Raw (r, s) as a KMS would produce: any valid ECDSA signature, high or low s. */
export async function rawSign(
  privateKey: Hex,
  digest: Hex,
  highS: boolean,
): Promise<{ r: bigint; s: bigint }> {
  const sig = await sign({ hash: digest, privateKey });
  const r = BigInt(sig.r);
  const s = BigInt(sig.s); // viem returns low s
  return { r, s: highS ? N - s : s };
}

export interface FakeKmsOptions {
  privateKey: Hex;
  /** `high`: always return the high-s twin; `low`: never; `alternate`: every other call. */
  sMode?: 'high' | 'low' | 'alternate';
  metadata?: Record<string, unknown>;
  publicKey?: Partial<Record<'KeyId' | 'PublicKey' | 'KeySpec' | 'KeyUsage', unknown>>;
  /** Replaces the Sign handler (to inject errors, delays or malformed output). */
  onSign?: (input: SignCommand['input'], signal: AbortSignal) => Promise<unknown>;
  onDescribe?: () => Promise<unknown>;
  onGetPublicKey?: () => Promise<unknown>;
}

/**
 * A software secp256k1 key behind the KMS API surface `KmsSigner` uses. It answers with the
 * same shapes as AWS (DER SPKI, DER ECDSA signatures) and asserts the request parameters.
 */
export class FakeKms implements KmsTransport {
  readonly calls: KmsCommand[] = [];
  readonly signals: AbortSignal[] = [];
  private signCount = 0;

  constructor(private readonly opts: FakeKmsOptions) {}

  get address(): Hex {
    return privateKeyToAccount(this.opts.privateKey).address;
  }

  async send(command: KmsCommand, options: { abortSignal: AbortSignal }): Promise<unknown> {
    this.calls.push(command);
    this.signals.push(options.abortSignal);
    if (command instanceof DescribeKeyCommand) {
      if (this.opts.onDescribe) return this.opts.onDescribe();
      return {
        KeyMetadata: {
          Arn: FAKE_KEY_ARN,
          KeyId: '1234abcd-12ab-34cd-56ef-1234567890ab',
          KeyState: 'Enabled',
          KeySpec: 'ECC_SECG_P256K1',
          KeyUsage: 'SIGN_VERIFY',
          KeyManager: 'CUSTOMER',
          Origin: 'AWS_KMS',
          SigningAlgorithms: ['ECDSA_SHA_256'],
          ...this.opts.metadata,
        },
      };
    }
    if (command instanceof GetPublicKeyCommand) {
      if (this.opts.onGetPublicKey) return this.opts.onGetPublicKey();
      return {
        KeyId: FAKE_KEY_ARN,
        PublicKey: spkiFor(this.opts.privateKey),
        KeySpec: 'ECC_SECG_P256K1',
        KeyUsage: 'SIGN_VERIFY',
        SigningAlgorithms: ['ECDSA_SHA_256'],
        ...this.opts.publicKey,
      };
    }
    if (this.opts.onSign) return this.opts.onSign(command.input, options.abortSignal);
    return this.sign(command);
  }

  private async sign(command: SignCommand): Promise<unknown> {
    const { KeyId, Message, MessageType, SigningAlgorithm } = command.input;
    if (KeyId !== FAKE_KEY_ARN) throw new Error(`fake KMS: unexpected KeyId ${String(KeyId)}`);
    if (MessageType !== 'DIGEST' || SigningAlgorithm !== 'ECDSA_SHA_256') {
      throw new Error('fake KMS: expected DIGEST / ECDSA_SHA_256');
    }
    if (!(Message instanceof Uint8Array) || Message.length !== 32) {
      throw new Error('fake KMS: a DIGEST for ECDSA_SHA_256 is exactly 32 bytes');
    }
    const mode = this.opts.sMode ?? 'alternate';
    const highS = mode === 'high' || (mode === 'alternate' && this.signCount % 2 === 0);
    this.signCount++;
    const { r, s } = await rawSign(this.opts.privateKey, bytesToHex(Message), highS);
    return {
      KeyId: FAKE_KEY_ARN,
      Signature: derSignature(r, s),
      SigningAlgorithm: 'ECDSA_SHA_256',
    };
  }
}

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { keccak256, padHex, recoverAddress, serializeSignature, toHex, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { derInteger, derSignature, rawSign, spkiFor } from '../../testing/fake-kms.js';
import {
  addressFromPublicKey,
  isOnCurve,
  normalizeS,
  parseDerSignature,
  parseSecp256k1Spki,
  SECP256K1_HALF_N,
  SECP256K1_N,
  SECP256K1_P,
  toEthereumSignature,
  verifiesAs,
} from './ecdsa.js';

const KEY = padHex('0xa11ce', { size: 32 });
const ACCOUNT = privateKeyToAccount(KEY);
const digest = (i: number): Hex => keccak256(toHex(`ranvier ecdsa test ${i}`));

/** OpenZeppelin ECDSA's malleability bound, copied from ECDSA.sol (not derived from n). */
const OZ_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

describe('secp256k1 constants', () => {
  it('match the curve and OpenZeppelin', () => {
    expect(SECP256K1_HALF_N).toBe(OZ_HALF_N);
    expect(SECP256K1_P).toBe(0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn);
    expect(SECP256K1_N % 2n).toBe(1n);
  });
});

describe('parseSecp256k1Spki', () => {
  it('extracts the uncompressed key from an OpenSSL-encoded SPKI', () => {
    const point = parseSecp256k1Spki(spkiFor(KEY));
    expect(point).toBe(ACCOUNT.publicKey);
    expect(addressFromPublicKey(point)).toBe(ACCOUNT.address);
  });

  it('derives the right address for random OpenSSL keys', () => {
    for (let i = 0; i < 5; i++) {
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
      const d = privateKey.export({ format: 'jwk' }).d ?? '';
      const hex = `0x${Buffer.from(d, 'base64url').toString('hex').padStart(64, '0')}` as Hex;
      const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
      expect(addressFromPublicKey(parseSecp256k1Spki(spki))).toBe(privateKeyToAccount(hex).address);
    }
  });

  it('refuses other curves, compressed points, bad prefixes and off-curve points', () => {
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
      type: 'spki',
      format: 'der',
    });
    expect(() => parseSecp256k1Spki(new Uint8Array(p256))).toThrow('not an uncompressed');
    const good = spkiFor(KEY);
    expect(() => parseSecp256k1Spki(good.subarray(0, 87))).toThrow('(87 bytes)');
    for (const index of [0, 12, 19, 23]) {
      const bad = Uint8Array.from(good);
      bad[index] = (bad[index] ?? 0) ^ 0x01; // curve OID, algorithm OID, point format
      expect(() => parseSecp256k1Spki(bad), String(index)).toThrow('not an uncompressed');
    }
    const offCurve = Uint8Array.from(good);
    offCurve[87] = (offCurve[87] ?? 0) ^ 0x01;
    expect(() => parseSecp256k1Spki(offCurve)).toThrow('not a point on secp256k1');
  });

  it('checks curve membership and coordinate ranges', () => {
    const pub = ACCOUNT.publicKey;
    const x = BigInt(`0x${pub.slice(4, 68)}`);
    const y = BigInt(`0x${pub.slice(68)}`);
    expect(isOnCurve(x, y)).toBe(true);
    expect(isOnCurve(x, SECP256K1_P - y)).toBe(true);
    expect(isOnCurve(x, y + 1n)).toBe(false);
    expect(isOnCurve(-1n, y)).toBe(false);
    expect(isOnCurve(x, SECP256K1_P)).toBe(false);
    expect(isOnCurve(SECP256K1_P + x, y)).toBe(false);
    expect(isOnCurve(x, -y)).toBe(false);
  });
});

describe('parseDerSignature', () => {
  const bytes = (...b: number[]) => Uint8Array.from(b);

  it('parses 33-byte (0x00-padded), 32-byte and short integers', () => {
    const highR = 0x80n << 248n; // top bit set: needs 0x00
    const shortR = 0x7fn << 232n; // 30 bytes
    const tinyS = 1n;
    for (const [r, s] of [
      [highR, SECP256K1_HALF_N],
      [shortR, tinyS],
      [SECP256K1_N - 1n, SECP256K1_N - 1n],
      [1n, 0x80n],
    ] as const) {
      expect(parseDerSignature(derSignature(r, s))).toEqual({ r, s });
    }
    expect(derInteger(highR)).toHaveLength(2 + 33);
    expect(derInteger(shortR)).toHaveLength(2 + 30);
  });

  it('refuses malformed DER', () => {
    const ok = [...derSignature(5n, 7n)]; // 30 06 02 01 05 02 01 07
    const cases: [string, Uint8Array, string][] = [
      ['too short', bytes(0x30, 0x04, 0x02, 0x01, 0x05, 0x02), 'bad length'],
      ['too long', new Uint8Array(73), 'bad length'],
      ['not a sequence', bytes(0x31, ...ok.slice(1)), 'expected SEQUENCE'],
      ['sequence length', bytes(0x30, 0x07, ...ok.slice(2)), 'bad SEQUENCE length'],
      ['r not an integer', bytes(0x30, 0x06, 0x03, ...ok.slice(3)), 'expected INTEGER'],
      ['s not an integer', bytes(...ok.slice(0, 5), 0x04, 0x01, 0x07), 'expected INTEGER'],
      ['zero length', bytes(0x30, 0x06, 0x02, 0x00, 0x02, 0x02, 0x07, 0x07), 'bad INTEGER length'],
      [
        'over 33 bytes',
        bytes(0x30, 0x26, 0x02, 0x22, ...new Array<number>(36).fill(1)),
        'bad INTEGER length',
      ],
      [
        's length missing',
        bytes(0x30, 0x06, 0x02, 0x03, 0x01, 0x02, 0x03, 0x02),
        'bad INTEGER length',
      ],
      ['truncated', bytes(0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x05, 0x07), 'truncated'],
      ['negative', bytes(0x30, 0x06, 0x02, 0x01, 0x85, 0x02, 0x01, 0x07), 'negative'],
      ['non-minimal', bytes(0x30, 0x07, 0x02, 0x02, 0x00, 0x05, 0x02, 0x01, 0x07), 'non-minimal'],
      ['trailing', bytes(0x30, 0x08, ...ok.slice(2), 0x00, 0x00), 'trailing bytes'],
      ['r zero', derSignature(0n, 7n), 'r out of range'],
      ['s = n', derSignature(5n, SECP256K1_N), 's out of range'],
      ['r > n', derSignature(SECP256K1_N + 1n, 7n), 'r out of range'],
    ];
    for (const [name, der, message] of cases) {
      expect(() => parseDerSignature(der), name).toThrow(message);
    }
    // A single 0x00 is the minimal encoding of zero (then refused as out of range).
    expect(() => parseDerSignature(bytes(0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x07))).toThrow(
      'r out of range',
    );
  });
});

describe('normalizeS', () => {
  it('keeps low s and flips high s', () => {
    expect(normalizeS(1n)).toBe(1n);
    expect(normalizeS(SECP256K1_HALF_N)).toBe(SECP256K1_HALF_N);
    expect(normalizeS(SECP256K1_HALF_N + 1n)).toBe(SECP256K1_HALF_N);
    expect(normalizeS(SECP256K1_N - 1n)).toBe(1n);
  });
});

describe('toEthereumSignature', () => {
  it('matches a low-s software signature for high- and low-s input, with both v values', async () => {
    const vs = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const hash = digest(i);
      const expected = serializeSignature(await sign({ hash, privateKey: KEY }));
      for (const highS of [false, true]) {
        const raw = await rawSign(KEY, hash, highS);
        expect(raw.s > SECP256K1_HALF_N).toBe(highS);
        const sig = await toEthereumSignature(hash, raw, ACCOUNT.address);
        expect(sig).toBe(expected);
        expect(await verifiesAs(hash, sig, ACCOUNT.address)).toBe(true);
        expect(await recoverAddress({ hash, signature: sig })).toBe(ACCOUNT.address);
      }
      vs.add(expected.slice(-2));
    }
    expect([...vs].sort()).toEqual(['1b', '1c']);
  });

  it('refuses a signature from another key', async () => {
    const other = padHex('0xb0b', { size: 32 });
    const raw = await rawSign(other, digest(1), false);
    await expect(toEthereumSignature(digest(1), raw, ACCOUNT.address)).rejects.toThrow(
      'does not recover',
    );
  });

  it('refuses an r that is not on the curve for either recovery bit', async () => {
    // x = 5 has no point on secp256k1: 5^3 + 7 = 132 is not a square mod p (Euler).
    let pow = 1n;
    for (let b = 132n, e = (SECP256K1_P - 1n) / 2n; e > 0n; e >>= 1n, b = (b * b) % SECP256K1_P) {
      if (e & 1n) pow = (pow * b) % SECP256K1_P;
    }
    expect(pow).toBe(SECP256K1_P - 1n);
    await expect(toEthereumSignature(digest(2), { r: 5n, s: 7n }, ACCOUNT.address)).rejects.toThrow(
      'does not recover',
    );
  });
});

describe('verifiesAs', () => {
  it('accepts only what OpenZeppelin tryRecover accepts from this signer', async () => {
    const hash = digest(3);
    const good = serializeSignature(await sign({ hash, privateKey: KEY }));
    expect(await verifiesAs(hash, good, ACCOUNT.address)).toBe(true);
    expect(
      await verifiesAs(hash, good.toUpperCase().replace('0X', '0x') as Hex, ACCOUNT.address),
    ).toBe(true);
    const r = BigInt(good.slice(0, 66));
    const s = BigInt(`0x${good.slice(66, 130)}`);
    const v = good.slice(130);
    const build = (rr: bigint, ss: bigint, vv: string): Hex =>
      `${toHex(rr, { size: 32 })}${toHex(ss, { size: 32 }).slice(2)}${vv}` as Hex;
    const flipped = v === '1b' ? '1c' : '1b';
    expect(await verifiesAs(hash, build(r, SECP256K1_N - s, flipped), ACCOUNT.address)).toBe(false);
    expect(await verifiesAs(hash, build(r, s, '00'), ACCOUNT.address)).toBe(false);
    expect(await verifiesAs(hash, build(r, s, '1d'), ACCOUNT.address)).toBe(false);
    expect(await verifiesAs(hash, build(0n, s, v), ACCOUNT.address)).toBe(false);
    expect(await verifiesAs(hash, build(r, 0n, v), ACCOUNT.address)).toBe(false);
    expect(await verifiesAs(hash, build(5n, s, v), ACCOUNT.address)).toBe(false);
    expect(await verifiesAs(digest(4), good, ACCOUNT.address)).toBe(false);
    expect(await verifiesAs(hash, good.slice(0, 130) as Hex, ACCOUNT.address)).toBe(false);
    expect(await verifiesAs(hash, `${good}00` as Hex, ACCOUNT.address)).toBe(false);
  });
});

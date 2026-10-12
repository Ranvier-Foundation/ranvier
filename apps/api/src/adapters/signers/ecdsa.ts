import { bytesToHex, getAddress, recoverAddress, serializeSignature, toHex, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

/**
 * Pure secp256k1 helpers for turning a KMS signer's output into an Ethereum signature.
 * Everything here is strict: malformed input throws, it is never repaired or guessed.
 */

/** secp256k1 field prime p. */
export const SECP256K1_P = 2n ** 256n - 2n ** 32n - 977n;
/** secp256k1 group order n. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/**
 * Largest `s` OpenZeppelin `ECDSA.tryRecover` accepts (floor(n / 2)). Above it a signature is
 * rejected as malleable, so every signature we return must have `s <= SECP256K1_HALF_N`.
 */
export const SECP256K1_HALF_N = SECP256K1_N / 2n;

/**
 * DER prefix of a SubjectPublicKeyInfo (RFC 5280) for an uncompressed secp256k1 key:
 * SEQUENCE(86) { SEQUENCE(16) { OID 1.2.840.10045.2.1 (id-ecPublicKey),
 * OID 1.3.132.0.10 (secp256k1) }, BIT STRING(66) { 0 unused bits, 0x04 } }, then X || Y.
 * This is the only encoding of such a key, so the whole prefix is compared byte for byte.
 */
const SPKI_SECP256K1_PREFIX = Uint8Array.from([
  0x30, 0x56, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b,
  0x81, 0x04, 0x00, 0x0a, 0x03, 0x42, 0x00, 0x04,
]);
const SPKI_SECP256K1_LENGTH = SPKI_SECP256K1_PREFIX.length + 64;

/** Callers pass non-empty byte strings only. */
function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(bytesToHex(bytes));
}

/** Byte `i` of `bytes`; throws RangeError out of bounds (callers check bounds first). */
function byteAt(bytes: Uint8Array, i: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint8(i);
}

/** True when (x, y) is a point on y^2 = x^3 + 7 over the secp256k1 field. */
export function isOnCurve(x: bigint, y: bigint): boolean {
  if (x < 0n || x >= SECP256K1_P || y < 0n || y >= SECP256K1_P) return false;
  const p = SECP256K1_P;
  return (y * y) % p === (((x * x) % p) * x + 7n) % p;
}

/**
 * Parses a DER SubjectPublicKeyInfo holding an uncompressed secp256k1 key (what KMS
 * `GetPublicKey` returns for an ECC_SECG_P256K1 key). Returns the 65-byte `0x04 || X || Y`.
 * Refuses any other curve, algorithm, compressed points and points off the curve.
 */
export function parseSecp256k1Spki(spki: Uint8Array): Hex {
  if (spki.length !== SPKI_SECP256K1_LENGTH) {
    throw new Error(`public key is not an uncompressed secp256k1 SPKI (${spki.length} bytes)`);
  }
  for (let i = 0; i < SPKI_SECP256K1_PREFIX.length; i++) {
    if (spki[i] !== SPKI_SECP256K1_PREFIX[i]) {
      throw new Error('public key is not an uncompressed secp256k1 SPKI');
    }
  }
  const point = spki.subarray(SPKI_SECP256K1_PREFIX.length - 1);
  const x = bytesToBigInt(point.subarray(1, 33));
  const y = bytesToBigInt(point.subarray(33, 65));
  if (!isOnCurve(x, y)) throw new Error('public key is not a point on secp256k1');
  return bytesToHex(point);
}

/** Ethereum address (checksummed) of a 65-byte uncompressed secp256k1 public key. */
export function addressFromPublicKey(uncompressed: Hex): Hex {
  return getAddress(publicKeyToAddress(uncompressed));
}

/** Reads one DER INTEGER at `offset`; strict (minimal, positive, at most 33 bytes). */
function readDerInteger(der: Uint8Array, offset: number): { value: bigint; next: number } {
  if (der[offset] !== 0x02) throw new Error('DER signature: expected INTEGER');
  const len = der[offset + 1];
  // r and s are below n < 2^256: at most 32 bytes, plus one 0x00 when the top bit is set.
  if (len === undefined || len < 1 || len > 33)
    throw new Error('DER signature: bad INTEGER length');
  const start = offset + 2;
  const end = start + len;
  if (end > der.length) throw new Error('DER signature: truncated INTEGER');
  const bytes = der.subarray(start, end);
  const first = byteAt(bytes, 0);
  if (first & 0x80) throw new Error('DER signature: negative INTEGER');
  // A leading 0x00 is only allowed (and required) when the next byte has its top bit set.
  if (first === 0x00 && len > 1 && (byteAt(bytes, 1) & 0x80) === 0) {
    throw new Error('DER signature: non-minimal INTEGER');
  }
  return { value: bytesToBigInt(bytes), next: end };
}

/**
 * Parses an ASN.1 DER ECDSA signature, `SEQUENCE { INTEGER r, INTEGER s }` (RFC 3279
 * section 2.2.3), as KMS `Sign` returns for ECDSA_SHA_256. Strict DER: short-form lengths,
 * minimal integers, no trailing bytes, and 1 <= r, s < n.
 */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  // The largest valid signature is 2 + 2 * (2 + 33) = 72 bytes, so lengths are short-form.
  if (der.length < 8 || der.length > 72) throw new Error('DER signature: bad length');
  if (der[0] !== 0x30) throw new Error('DER signature: expected SEQUENCE');
  if (der[1] !== der.length - 2) throw new Error('DER signature: bad SEQUENCE length');
  const r = readDerInteger(der, 2);
  const s = readDerInteger(der, r.next);
  if (s.next !== der.length) throw new Error('DER signature: trailing bytes');
  for (const [name, v] of [
    ['r', r.value],
    ['s', s.value],
  ] as const) {
    if (v === 0n || v >= SECP256K1_N) throw new Error(`DER signature: ${name} out of range`);
  }
  return { r: r.value, s: s.value };
}

/** Moves `s` to the lower half of the group order (EIP-2 / OpenZeppelin low-s rule). */
export function normalizeS(s: bigint): bigint {
  return s > SECP256K1_HALF_N ? SECP256K1_N - s : s;
}

/**
 * Turns (r, s) over `digest` into a 65-byte `r || s || v` signature (v in {27, 28}) that
 * OpenZeppelin `ECDSA.tryRecover` accepts and that recovers to `expected`.
 *
 * `s` is normalised to the low half first. The recovery bit is not reported by KMS, so both
 * candidates are tried against the known signer address; if neither recovers to it, the
 * signature is not from this key and this throws. The caller must still not return the
 * result without its own final check (defence in depth; see `KmsSigner`).
 */
export async function toEthereumSignature(
  digest: Hex,
  sig: { r: bigint; s: bigint },
  expected: Hex,
): Promise<Hex> {
  const r = toHex(sig.r, { size: 32 });
  const s = toHex(normalizeS(sig.s), { size: 32 });
  const wanted = expected.toLowerCase();
  for (const yParity of [0, 1] as const) {
    let recovered: string;
    try {
      recovered = await recoverAddress({ hash: digest, signature: { r, s, yParity } });
    } catch {
      continue; // r is not the x-coordinate of a point for this parity
    }
    if (recovered.toLowerCase() === wanted) return serializeSignature({ r, s, yParity });
  }
  throw new Error('signature does not recover to the signer address for either recovery bit');
}

/**
 * The checks OpenZeppelin `ECDSA.tryRecover` applies to a 65-byte signature, plus recovery
 * to `expected`. True only if the wrapper would accept this signature from this signer.
 */
export async function verifiesAs(digest: Hex, signature: Hex, expected: Hex): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (r === 0n || s === 0n || s > SECP256K1_HALF_N || (v !== 27 && v !== 28)) return false;
  try {
    const recovered = await recoverAddress({ hash: digest, signature });
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

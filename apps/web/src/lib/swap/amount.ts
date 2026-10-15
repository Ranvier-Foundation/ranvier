import { MAX_AMOUNT_CHARS } from './config';

/**
 * Amounts the person types, as exact decimal text and bigint base units. Pure string and bigint
 * maths: no `Number`, `parseFloat` or float anywhere (money is never a float, CLAUDE.md).
 */

export const MAX_UINT256 = 2n ** 256n - 1n;

/** Optional comma grouping as pasted from elsewhere ("1,000.5"); anything else with a comma is refused. */
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;
const PLAIN = /^\d*\.?\d*$/;

/**
 * Cleans what the field would hold after an edit, or returns `null` to refuse the edit (the
 * caller keeps the previous text). Refused: more than `MAX_AMOUNT_CHARS` characters, anything but
 * ASCII digits and one decimal point (so no sign, exponent, letters, spaces inside or other
 * scripts' digits), more fraction digits than the token has decimals, and any decimal point at
 * all for a token with 0 decimals. Surrounding spaces are trimmed; comma grouping is removed.
 */
export function cleanAmountText(raw: string, decimals: number): string | null {
  if (raw.length > MAX_AMOUNT_CHARS) return null;
  let text = raw.trim();
  if (text.includes(',')) {
    if (!GROUPED.test(text)) return null;
    text = text.replaceAll(',', '');
  }
  if (!PLAIN.test(text)) return null;
  const dot = text.indexOf('.');
  if (dot === -1) return text;
  if (decimals === 0) return null;
  if (text.length - dot - 1 > decimals) return null;
  return text;
}

/** Cuts fraction digits beyond `decimals` (never rounds), for a token change. */
export function fitToDecimals(text: string, decimals: number): string {
  const dot = text.indexOf('.');
  if (dot === -1) return text;
  if (decimals === 0) return text.slice(0, dot);
  return text.slice(0, dot + 1 + decimals);
}

export type AmountParse =
  | { kind: 'empty' }
  | { kind: 'zero' }
  | { kind: 'too_large' }
  | { kind: 'invalid' }
  | { kind: 'ok'; units: bigint };

/** Base units of the text for a token with `decimals` places. Exact: nothing is rounded. */
export function parseAmount(text: string, decimals: number): AmountParse {
  const clean = cleanAmountText(text, decimals);
  if (clean === null) return { kind: 'invalid' };
  const dot = clean.indexOf('.');
  const whole = dot === -1 ? clean : clean.slice(0, dot);
  const fraction = dot === -1 ? '' : clean.slice(dot + 1);
  if (whole === '' && fraction === '') return { kind: 'empty' };
  const units = BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) +
    BigInt(fraction === '' ? '0' : fraction.padEnd(decimals, '0'));
  if (units === 0n) return { kind: 'zero' };
  if (units > MAX_UINT256) return { kind: 'too_large' };
  return { kind: 'ok', units };
}

/** Every digit of an amount, no grouping, trailing zeros trimmed ("0.5", "1000"): the inverse of `parseAmount`. */
export function formatUnitsExact(units: bigint, decimals: number): string {
  if (units < 0n || !Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError('amount must not be negative and decimals must be a whole number');
  }
  const scale = 10n ** BigInt(decimals);
  const whole = (units / scale).toString();
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * Exact decimal-string to fixed-point conversion for oracle prices, so no float ever
 * enters the money path. Accepts JSON number syntax: `12`, `0.00000042`, `4.2e-7`, `1E+21`.
 */
const JSON_NUMBER = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Exponents beyond this are rejected rather than producing absurd bigints. */
const MAX_EXPONENT = 100;

/** Parses `source` and returns `value * 10^scale`, rounded down (towards zero). */
export function parseDecimalScaled(source: string, scale: number): bigint {
  const match = JSON_NUMBER.exec(source);
  if (!match) throw new RangeError(`not a decimal number: ${source.slice(0, 40)}`);
  const [, sign = '', int = '', frac = '', exp = '0'] = match;
  const exponent = Number(exp);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    throw new RangeError('exponent out of range');
  }
  // value = digits * 10^(exponent - frac.length); multiply by 10^scale.
  const digits = BigInt(int + frac);
  const shift = exponent - frac.length + scale;
  const magnitude = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  return sign === '-' ? -magnitude : magnitude;
}

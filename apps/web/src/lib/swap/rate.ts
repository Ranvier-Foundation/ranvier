import { formatTokenAmount, formatUsd } from '@/lib/format';

/**
 * Rates derived from the quote's bigint amounts, never a float. "1 whole `denominator` token costs
 * X `numerator` units": `numerator * 10^denominatorDecimals / denominator`, rounded down. The
 * numerator is in its own base units (format it with its own decimals).
 */
export function unitRate(
  numerator: bigint,
  denominator: bigint,
  denominatorDecimals: number,
): bigint | undefined {
  if (denominator <= 0n || numerator < 0n) return undefined;
  return (numerator * 10n ** BigInt(denominatorDecimals)) / denominator;
}

/**
 * A rate for display. From 1 up it reads like an amount (grouped, up to four places, trailing
 * zeros trimmed: "2,489.08"). Below 1 it keeps four significant digits ("0.0004017"), because a
 * rate such as 0.0004 must not round to nothing. Truncated, never rounded up.
 */
export function formatRate(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  if (units >= scale) return formatTokenAmount(units, decimals);
  const fraction = units.toString().padStart(decimals, '0');
  const leadingZeros = fraction.length - fraction.replace(/^0+/, '').length;
  const shown = fraction.slice(0, leadingZeros + 4).replace(/0+$/, '');
  return shown === '' ? '0' : `0.${shown}`;
}

/** USD (integer cents) of one whole token, from the value of `amount` base units of it. */
export function usdPerToken(
  usdCents: bigint,
  amount: bigint,
  decimals: number,
): string | undefined {
  const cents = unitRate(usdCents, amount, decimals);
  return cents === undefined ? undefined : formatUsd(cents);
}

/** Formats integer USD cents as "$1,234.56". Money is never a float (CLAUDE.md). */
export function formatUsd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars}.${rest}`;
}

/** 0x7a3E...3F9c style short form for an EVM address (first 6, last 4 characters). */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Most fraction digits shown for a token amount unless the caller asks for fixed places. */
export const MAX_AMOUNT_FRACTION_DIGITS = 4;

/**
 * Formats a token amount (bigint base units) for display. Pure integer maths, never a float, and
 * it truncates instead of rounding so a balance is never shown larger than it is. By default up to
 * four fraction digits with trailing zeros trimmed ("0.0841", "3.2"); with `fixed` that many places
 * exactly ("2,410.50"). A non-zero amount too small for the places shown reads "<0.0001".
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  opts: { fixed?: number } = {},
): string {
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError('amount must not be negative and decimals must be a whole number');
  }
  const places = Math.min(opts.fixed ?? MAX_AMOUNT_FRACTION_DIGITS, decimals);
  const scale = 10n ** BigInt(decimals);
  const whole = group((amount / scale).toString());
  const fraction = (amount % scale).toString().padStart(decimals, '0').slice(0, places);
  const shown =
    opts.fixed === undefined ? fraction.replace(/0+$/, '') : fraction.padEnd(opts.fixed, '0');
  if (amount !== 0n && whole === '0' && !/[1-9]/.test(fraction)) {
    const floor = opts.fixed ?? MAX_AMOUNT_FRACTION_DIGITS;
    return `<0.${'0'.repeat(Math.max(floor - 1, 0))}1`;
  }
  return shown === '' ? whole : `${whole}.${shown}`;
}

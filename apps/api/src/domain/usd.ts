import type { UsdCents } from '@ranvier/types';
import type { TokenPrice } from '../ports/price-oracle.js';

/** 10^18 attoUSD per USD; 10^16 attoUSD per cent. */
const ATTO_PER_CENT = 10n ** 16n;

/** USD value of `amount` base units in attoUSD (USD * 10^18), rounded down. */
export function usdE18(price: TokenPrice, amount: bigint): bigint {
  if (amount < 0n) throw new RangeError('amount must be non-negative');
  return (amount * price.usdE18) / 10n ** BigInt(price.decimals);
}

/** USD value of `amount` base units in integer cents, rounded down. */
export function usdCents(price: TokenPrice, amount: bigint): UsdCents {
  if (amount < 0n) throw new RangeError('amount must be non-negative');
  return (amount * price.usdE18) / (10n ** BigInt(price.decimals) * ATTO_PER_CENT);
}

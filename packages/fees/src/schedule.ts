import { isStablecoin, isWrappedNative, NATIVE } from '@ranvier/chains';
import type { FeeQuote, FeeReason, Token, UsdCents } from '@ranvier/types';

/** Must match MAX_FEE_BPS in contracts/src/FeeWrapper.sol. */
export const MAX_FEE_BPS = 30;
export const BPS_DENOMINATOR = 10_000n;

export const FIRST_SWAP_PROMO_CAP: UsdCents = 1_000_00n;
const TIER_1_UPPER: UsdCents = 10_000_00n;
const TIER_2_UPPER: UsdCents = 100_000_00n;

export interface FeeInput {
  sellToken: Token;
  buyToken: Token;
  sellAmount: bigint;
  /** USD value of `sellAmount` at quote time. */
  usdValue: UsdCents;
  /** True if the wallet has never completed a swap on Ranvier. */
  isFirstSwap: boolean;
}

function isWrapOrUnwrap(a: Token, b: Token): boolean {
  if (a.chain !== b.chain) return false;
  const aNative = a.address === NATIVE;
  const bNative = b.address === NATIVE;
  return (
    (aNative && isWrappedNative(b.chain, b.address)) ||
    (bNative && isWrappedNative(a.chain, a.address))
  );
}

function isStablePair(a: Token, b: Token): boolean {
  return isStablecoin(a.chain, a.address) && isStablecoin(b.chain, b.address);
}

/** Fee schedule from spec section 2; precedence is recorded in ADR 0002. */
export function feeRate(input: FeeInput): { bps: number; reason: FeeReason } {
  const { sellToken, buyToken, usdValue, isFirstSwap } = input;
  if (usdValue < 0n) throw new RangeError('usdValue must be non-negative');

  if (isWrapOrUnwrap(sellToken, buyToken)) return { bps: 0, reason: 'wrap-unwrap' };
  if (isFirstSwap && usdValue <= FIRST_SWAP_PROMO_CAP)
    return { bps: 0, reason: 'first-swap-promo' };
  if (isStablePair(sellToken, buyToken)) return { bps: 5, reason: 'stablecoin' };
  if (usdValue < TIER_1_UPPER) return { bps: 20, reason: 'tier-under-10k' };
  if (usdValue <= TIER_2_UPPER) return { bps: 15, reason: 'tier-10k-100k' };
  return { bps: 10, reason: 'tier-over-100k' };
}

export function feeAmount(sellAmount: bigint, bps: number): bigint {
  if (sellAmount < 0n) throw new RangeError('sellAmount must be non-negative');
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) {
    throw new RangeError(`bps must be an integer between 0 and ${MAX_FEE_BPS}`);
  }
  return (sellAmount * BigInt(bps)) / BPS_DENOMINATOR;
}

export function quoteFee(input: FeeInput): FeeQuote {
  const { bps, reason } = feeRate(input);
  return { bps, reason, amount: feeAmount(input.sellAmount, bps) };
}

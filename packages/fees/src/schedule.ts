import { isStablecoin, isWrappedNative, NATIVE } from '@ranvier/chains';
import type { FeeQuote, FeeReason, TokenRef, UsdCents } from '@ranvier/types';

/** Must match MAX_FEE_BPS in contracts/src/FeeWrapper.sol. */
export const MAX_FEE_BPS = 30;
export const BPS_DENOMINATOR = 10_000n;

export const FIRST_SWAP_PROMO_CAP: UsdCents = 1_000_00n;
const TIER_1_UPPER: UsdCents = 10_000_00n;
const TIER_2_UPPER: UsdCents = 100_000_00n;

export interface FeeInput {
  sellToken: TokenRef;
  buyToken: TokenRef;
  sellAmount: bigint;
  /** USD value of `sellAmount` at quote time. */
  usdValue: UsdCents;
  /** True if the wallet has never completed a swap on Ranvier. */
  isFirstSwap: boolean;
}

/**
 * True when one side is the chain's native coin and the other is that same chain's
 * wrapped native token (e.g. ETH <-> WETH on one chain). Free by the fee schedule.
 */
export function isWrapOrUnwrap(a: TokenRef, b: TokenRef): boolean {
  if (a.chain !== b.chain) return false;
  const aNative = a.address === NATIVE;
  const bNative = b.address === NATIVE;
  return (
    (aNative && isWrappedNative(b.chain, b.address)) ||
    (bNative && isWrappedNative(a.chain, a.address))
  );
}

function isStablePair(a: TokenRef, b: TokenRef): boolean {
  return isStablecoin(a.chain, a.address) && isStablecoin(b.chain, b.address);
}

/**
 * Base rate from the fee schedule (spec section 2), before any promotion.
 * Precedence is recorded in ADR 0002.
 */
export function feeRate(input: Pick<FeeInput, 'sellToken' | 'buyToken' | 'usdValue'>): {
  bps: number;
  reason: Exclude<FeeReason, 'first-swap-promo'>;
} {
  const { sellToken, buyToken, usdValue } = input;
  if (usdValue < 0n) throw new RangeError('usdValue must be non-negative');

  if (isWrapOrUnwrap(sellToken, buyToken)) return { bps: 0, reason: 'wrap-unwrap' };
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

/**
 * Fee for a swap. On a wallet's first swap the first $1,000 is free and only the
 * part above it pays the base rate; the rate tier still follows the full swap size.
 * Every division here rounds down, in the user's favour. The USD value that picks the tier is
 * itself rounded down to whole cents by the caller; since cheaper tiers need a larger value,
 * that can only put a swap within one cent above a boundary in the dearer tier, never the
 * cheaper one. On a first swap it can waive under one cent more than $1,000 (ADR 0004).
 */
export function quoteFee(input: FeeInput): FeeQuote {
  const { bps, reason } = feeRate(input);
  const { sellAmount, usdValue, isFirstSwap } = input;

  if (!isFirstSwap || bps === 0) {
    return { bps, reason, amount: feeAmount(sellAmount, bps), waivedUsd: 0n };
  }
  if (usdValue <= FIRST_SWAP_PROMO_CAP) {
    return { bps, reason: 'first-swap-promo', amount: 0n, waivedUsd: usdValue };
  }
  const chargedAmount = (sellAmount * (usdValue - FIRST_SWAP_PROMO_CAP)) / usdValue;
  return {
    bps,
    reason: 'first-swap-promo',
    amount: feeAmount(chargedAmount, bps),
    waivedUsd: FIRST_SWAP_PROMO_CAP,
  };
}

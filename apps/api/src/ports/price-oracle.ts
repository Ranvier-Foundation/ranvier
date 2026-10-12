import type { TokenRef } from '@ranvier/types';

/**
 * A trusted price for one token. Both fields come from the oracle or the chain registry,
 * never from the client, because together they set the USD value and so the fee tier.
 */
export interface TokenPrice {
  /** On-chain decimals: oracle metadata for tokens, the chain registry for the native coin. */
  decimals: number;
  /** USD price of one whole token, scaled by 10^18 and rounded down. Always positive. */
  usdE18: bigint;
}

export interface PriceOracle {
  /** Throws when no fresh, confident, positive price and trusted decimals are available. */
  price(token: TokenRef, signal: AbortSignal): Promise<TokenPrice>;
}

export interface SwapHistory {
  /** `wallet` is normalised (lowercase for EVM) before it reaches this port. */
  hasCompletedSwap(wallet: string): Promise<boolean>;
}

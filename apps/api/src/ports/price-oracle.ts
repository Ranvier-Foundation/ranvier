import type { Token, UsdCents } from '@ranvier/types';

export interface PriceOracle {
  /** USD value of `amount` base units of `token`, in cents. */
  usdValue(token: Token, amount: bigint, signal: AbortSignal): Promise<UsdCents>;
}

export interface SwapHistory {
  hasCompletedSwap(wallet: string): Promise<boolean>;
}

/** Chain families are isolated modules (spec section 5). */
export type ChainFamily = 'evm' | 'solana';

/** EVM chains use their numeric chain ID; non-EVM chains use a string key. */
export type ChainKey = `evm:${number}` | 'solana:mainnet';

export interface Token {
  chain: ChainKey;
  /** Contract address (EVM), mint address (Solana), or `native`. */
  address: string;
  symbol: string;
  decimals: number;
}

/** Integer cents. Never use floats for money. */
export type UsdCents = bigint;

export type FeeReason =
  | 'wrap-unwrap'
  | 'first-swap-promo'
  | 'stablecoin'
  | 'tier-under-10k'
  | 'tier-10k-100k'
  | 'tier-over-100k';

export interface FeeQuote {
  /** Rate applied to the charged part of the swap. */
  bps: number;
  reason: FeeReason;
  /** Fee in input-token base units. This exact amount is signed into the quote. */
  amount: bigint;
  /** USD value exempt from the fee (first-swap promotion), in cents. */
  waivedUsd: UsdCents;
}

export interface QuoteRequest {
  sellToken: Token;
  buyToken: Token;
  /** Input amount in base units, before the platform fee. */
  sellAmount: bigint;
  taker: string;
  /** Slippage tolerance in basis points. */
  slippageBps: number;
}

export interface RouteHop {
  protocol: string;
  fromToken: Token;
  toToken: Token;
}

/** A quote from one routing provider, already net of the platform fee. */
export interface ProviderQuote {
  provider: string;
  buyAmount: bigint;
  minBuyAmount: bigint;
  /** Estimated gas cost in USD cents, used to rank quotes by net output. */
  gasCostUsd: UsdCents;
  /** Value of `buyAmount` in USD cents, used to rank quotes by net output. */
  buyAmountUsd: UsdCents;
  route: RouteHop[];
  /** Router to call and its calldata (EVM) or serialised transaction (Solana). */
  tx: { to: string; data: string; value: bigint };
}

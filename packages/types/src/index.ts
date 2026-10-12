/** Chain families are isolated modules (spec section 5). */
export type ChainFamily = 'evm' | 'solana';

/** EVM chains use their numeric chain ID; non-EVM chains use a string key. */
export type ChainKey = `evm:${number}` | 'solana:mainnet';

/**
 * A token as a client names it: chain and address only. Everything used in money maths
 * (decimals, price) comes from a trusted source, never from the client.
 */
export interface TokenRef {
  chain: ChainKey;
  /** Contract address (EVM, lowercase once validated), mint address (Solana), or `native`. */
  address: string;
}

/** Token metadata for display. `decimals` here is never taken from a client request. */
export interface Token extends TokenRef {
  symbol: string;
  decimals: number;
}

/**
 * Display and ordering tags for a curated token. Tags never change fees: the stablecoin fee
 * uses the registry's `stablecoins` allowlist only (spec section 2).
 */
export type TokenTag = 'native' | 'wrapped-native' | 'stablecoin' | 'bridged';

/**
 * A token from the curated, checked-in token list (ADR 0006). Its `decimals` are trusted data:
 * the price oracle's decimals must agree with them (ADR 0004).
 */
export interface TokenInfo extends Token {
  name: string;
  logoUri?: string;
  tags?: readonly TokenTag[];
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
  sellToken: TokenRef;
  buyToken: TokenRef;
  /** Input amount in base units, before the platform fee. */
  sellAmount: bigint;
  taker: string;
  /** Slippage tolerance in basis points. */
  slippageBps: number;
}

export interface RouteHop {
  /** Liquidity source, e.g. `Uniswap_V3`. */
  protocol: string;
  /** Token addresses on the quote's chain. */
  from: string;
  to: string;
  /** Share of the input routed through this hop, in basis points. */
  proportionBps: number;
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

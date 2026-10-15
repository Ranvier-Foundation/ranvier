import { getChain, listTokens, type ChainConfig } from '@ranvier/chains';
import type { ChainKey, TokenRef, TokenTag } from '@ranvier/types';
import { defaultPair } from '@/lib/defaults';
import { formatTokenAmount } from '@/lib/format';

/**
 * A token the swap screen can quote: its identity (`{ chain, address }`, the only thing the API
 * is ever told) and the display data and decimals of the checked-in list (ADR 0006). The list is
 * the same one the API cross-checks oracle decimals against, so the amount maths here and the
 * maths there use one source.
 */
export interface SwapToken {
  ref: TokenRef;
  chain: ChainConfig;
  symbol: string;
  name: string;
  decimals: number;
  tags: readonly TokenTag[];
}

/** The listed token for a picker result, or `undefined` when this build does not list it. */
export function resolveToken(ref: TokenRef): SwapToken | undefined {
  const chain = getChain(ref.chain);
  const listed = listTokens(ref.chain).find((tok) => tok.address === ref.address);
  if (!chain || !listed) return undefined;
  return {
    ref: { chain: ref.chain, address: listed.address },
    chain,
    symbol: listed.symbol,
    name: listed.name,
    decimals: listed.decimals,
    tags: listed.tags ?? [],
  };
}

export function sameToken(a: TokenRef, b: TokenRef): boolean {
  return a.chain === b.chain && a.address === b.address;
}

/** Stablecoins read like money: two places (as in the picker); other tokens up to four. */
const STABLE_PLACES = 2;

export function formatSwapAmount(units: bigint, token: SwapToken): string {
  return formatTokenAmount(
    units,
    token.decimals,
    token.tags.includes('stablecoin') ? { fixed: STABLE_PLACES } : {},
  );
}

export function chainName(key: ChainKey): string {
  return getChain(key)?.name ?? key;
}

/**
 * The pair the screen opens with, resolved from the registry and the checked-in list: the native
 * coin on Ethereum and the first listed stablecoin on the same chain (one chain, because the API
 * routes one chain at a time).
 */
export function defaultSwapTokens(): { pay: SwapToken; receive: SwapToken } {
  const { pay, receive } = defaultPair();
  const stable = receive.chain.stablecoins[receive.symbol];
  const payToken = resolveToken({ chain: pay.chain.key, address: 'native' });
  const receiveToken =
    stable === undefined ? undefined : resolveToken({ chain: receive.chain.key, address: stable });
  if (!payToken || !receiveToken)
    throw new Error('The default pair is missing from the token list');
  return { pay: payToken, receive: receiveToken };
}

import { CHAINS, getChain, type ChainConfig } from '@ranvier/chains';

/** One side of the default pair, taken from the chain registry (never typed in a component). */
export interface DefaultSide {
  chain: ChainConfig;
  symbol: string;
}

function chainOrThrow(key: 'evm:1'): ChainConfig {
  const chain = getChain(key);
  if (!chain) throw new Error(`Chain ${key} is missing from the registry`);
  return chain;
}

/**
 * Default pair: the native coin on Ethereum to the first listed stablecoin on Ethereum. Chains and
 * symbols come from @ranvier/chains. No amounts: fields start empty. Both sides are on one chain
 * because the API routes one chain at a time (ADR 0004); the canvas draws a cross-chain pair
 * (see Deviations in docs/ui-guidelines.md).
 */
export function defaultPair(): { pay: DefaultSide; receive: DefaultSide } {
  const ethereum = chainOrThrow('evm:1');
  const stable = Object.keys(ethereum.stablecoins)[0];
  if (!stable) throw new Error('Ethereum lists no stablecoin');
  return {
    pay: { chain: ethereum, symbol: ethereum.nativeSymbol },
    receive: { chain: ethereum, symbol: stable },
  };
}

/** Network shown in the header before the user picks one: the first chain in the registry. */
export function defaultNetwork(): ChainConfig {
  const first = CHAINS[0];
  if (!first) throw new Error('The chain registry is empty');
  return first;
}

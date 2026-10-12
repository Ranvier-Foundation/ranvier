import { CHAINS, getChain, type ChainConfig } from '@ranvier/chains';

/** One side of the default pair, taken from the chain registry (never typed in a component). */
export interface DefaultSide {
  chain: ChainConfig;
  symbol: string;
}

function chainOrThrow(key: 'evm:1' | 'evm:8453'): ChainConfig {
  const chain = getChain(key);
  if (!chain) throw new Error(`Chain ${key} is missing from the registry`);
  return chain;
}

/**
 * Signed-out default pair: the native coin on Ethereum to the first listed stablecoin on Base.
 * Chains and symbols come from @ranvier/chains. No amounts: fields start empty.
 */
export function defaultPair(): { pay: DefaultSide; receive: DefaultSide } {
  const ethereum = chainOrThrow('evm:1');
  const base = chainOrThrow('evm:8453');
  const stable = Object.keys(base.stablecoins)[0];
  if (!stable) throw new Error('Base lists no stablecoin');
  return {
    pay: { chain: ethereum, symbol: ethereum.nativeSymbol },
    receive: { chain: base, symbol: stable },
  };
}

/** Network shown in the header before the user picks one: the first chain in the registry. */
export function defaultNetwork(): ChainConfig {
  const first = CHAINS[0];
  if (!first) throw new Error('The chain registry is empty');
  return first;
}

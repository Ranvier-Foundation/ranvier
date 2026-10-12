import type { ChainFamily, ChainKey } from '@ranvier/types';

export interface ChainConfig {
  key: ChainKey;
  family: ChainFamily;
  name: string;
  nativeSymbol: string;
  /** Wrapped native token address, used to detect wrap/unwrap swaps. */
  wrappedNative: string;
  /** Allowlisted major stablecoins (spec section 2: stablecoin fee). */
  stablecoins: Record<string, string>;
  explorer: string;
  /** Chain name in the DefiLlama coins API (price oracle). */
  defillama: string;
}

/**
 * Chains are added here as config, not code (spec section 5).
 * RPC URLs are environment config and live outside this package.
 * Stablecoin addresses are lowercased for EVM so lookups are case-insensitive.
 */
export const CHAINS: readonly ChainConfig[] = [
  {
    key: 'evm:1',
    family: 'evm',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    wrappedNative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    stablecoins: {
      USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
    },
    explorer: 'https://etherscan.io',
    defillama: 'ethereum',
  },
  {
    key: 'evm:8453',
    family: 'evm',
    name: 'Base',
    nativeSymbol: 'ETH',
    wrappedNative: '0x4200000000000000000000000000000000000006',
    stablecoins: { USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    explorer: 'https://basescan.org',
    defillama: 'base',
  },
  {
    key: 'evm:42161',
    family: 'evm',
    name: 'Arbitrum One',
    nativeSymbol: 'ETH',
    wrappedNative: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    stablecoins: { USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
    explorer: 'https://arbiscan.io',
    defillama: 'arbitrum',
  },
  {
    key: 'solana:mainnet',
    family: 'solana',
    name: 'Solana',
    nativeSymbol: 'SOL',
    wrappedNative: 'So11111111111111111111111111111111111111112',
    stablecoins: {
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
    explorer: 'https://solscan.io',
    defillama: 'solana',
  },
];

export const NATIVE = 'native';

export function getChain(key: ChainKey): ChainConfig | undefined {
  return CHAINS.find((c) => c.key === key);
}

/** EVM addresses compare case-insensitively; Solana addresses are case-sensitive base58. */
export function normaliseAddress(chain: ChainConfig, address: string): string {
  return chain.family === 'evm' ? address.toLowerCase() : address;
}

export function isStablecoin(chainKey: ChainKey, address: string): boolean {
  const chain = getChain(chainKey);
  if (!chain) return false;
  const addr = normaliseAddress(chain, address);
  return Object.values(chain.stablecoins).includes(addr);
}

export function isWrappedNative(chainKey: ChainKey, address: string): boolean {
  const chain = getChain(chainKey);
  if (!chain) return false;
  return normaliseAddress(chain, address) === chain.wrappedNative;
}

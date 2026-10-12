import type { ChainFamily, ChainKey } from '@ranvier/types';

export interface ChainConfig {
  key: ChainKey;
  family: ChainFamily;
  name: string;
  nativeSymbol: string;
  /** Decimals of the native coin (18 on EVM, 9 for SOL). Trusted source for native amounts. */
  nativeDecimals: number;
  /** Wrapped native token address, used to detect wrap/unwrap swaps. */
  wrappedNative: string;
  /** Allowlisted major stablecoins (spec section 2: stablecoin fee). */
  stablecoins: Record<string, string>;
  /**
   * Checked-in decimals for every token this registry names (stablecoins, wrapped native),
   * keyed by normalised address. Oracle metadata that disagrees is refused (ADR 0004).
   */
  knownDecimals: Record<string, number>;
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
    nativeDecimals: 18,
    wrappedNative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    stablecoins: {
      USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
    },
    knownDecimals: {
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 18, // WETH
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
      '0x6b175474e89094c44da98b954eedeac495271d0f': 18, // DAI
    },
    explorer: 'https://etherscan.io',
    defillama: 'ethereum',
  },
  {
    key: 'evm:8453',
    family: 'evm',
    name: 'Base',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x4200000000000000000000000000000000000006',
    stablecoins: { USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    knownDecimals: {
      '0x4200000000000000000000000000000000000006': 18, // WETH
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // USDC
    },
    explorer: 'https://basescan.org',
    defillama: 'base',
  },
  {
    key: 'evm:42161',
    family: 'evm',
    name: 'Arbitrum One',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    wrappedNative: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    stablecoins: { USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
    knownDecimals: {
      '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 18, // WETH
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6, // USDC
    },
    explorer: 'https://arbiscan.io',
    defillama: 'arbitrum',
  },
  {
    key: 'solana:mainnet',
    family: 'solana',
    name: 'Solana',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    wrappedNative: 'So11111111111111111111111111111111111111112',
    stablecoins: {
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
    knownDecimals: {
      So11111111111111111111111111111111111111112: 9, // wSOL
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
    },
    explorer: 'https://solscan.io',
    defillama: 'solana',
  },
];

export const NATIVE = 'native';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Base58 alphabet (no 0, O, I, l); Solana public keys encode to 32-44 characters. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Ethereum-style placeholders for the native coin; Ranvier spells native only as `native`. */
const EVM_NATIVE_PLACEHOLDERS: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

/** Chain family from the key alone, so unregistered EVM chains still validate. */
export function chainFamily(key: ChainKey): ChainFamily {
  return key.startsWith('evm:') ? 'evm' : 'solana';
}

/** True for a well-formed account or contract address of the family (not `native`). */
export function isValidAddress(family: ChainFamily, address: string): boolean {
  return family === 'evm' ? EVM_ADDRESS.test(address) : SOLANA_ADDRESS.test(address);
}

/**
 * True for `native` or a well-formed token address of the family. On EVM the zero address and
 * 0xeeee...eeee are refused, so the native coin has exactly one spelling: `native`.
 */
export function isValidTokenAddress(family: ChainFamily, address: string): boolean {
  if (address === NATIVE) return true;
  if (family === 'evm' && EVM_NATIVE_PLACEHOLDERS.has(address.toLowerCase())) return false;
  return isValidAddress(family, address);
}

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

/**
 * Checked-in decimals for a token: the registry's native decimals for `native`, the
 * `knownDecimals` entry for a listed token, undefined for any other token.
 */
export function knownDecimals(chainKey: ChainKey, address: string): number | undefined {
  const chain = getChain(chainKey);
  if (!chain) return undefined;
  if (address === NATIVE) return chain.nativeDecimals;
  return chain.knownDecimals[normaliseAddress(chain, address)];
}

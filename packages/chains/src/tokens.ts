import type { ChainKey, TokenInfo, TokenTag } from '@ranvier/types';
import { deepFreeze } from './freeze.js';

/** The OP Stack L2StandardBridge predeploy, which mints Base's standard bridged tokens. */
export const OP_STANDARD_BRIDGE = '0x4200000000000000000000000000000000000010';
/** Arbitrum One L2 gateways (read from each token's `l2Gateway()` when it was listed). */
export const ARB_STANDARD_GATEWAY = '0x09e9222e96e7b4ae2a407b98d48e330053351eee';
export const ARB_WETH_GATEWAY = '0x6c411ad3e74de3e7bd422b94a27770f5b86c623b';
/** Maker's custom Dai gateway on Arbitrum One (its `l1Dai()` is L1 DAI, `l2Dai()` Arbitrum DAI). */
export const ARB_DAI_GATEWAY = '0x467194771dae2967aef3ecbedd3bf9a310c76c65';

/**
 * How a bridged token is linked to its L1 original, checked by `verify:tokens`:
 * - `op-stack`: `remoteToken()` is `l1Address` and `bridge()` is `gateway`;
 * - `arbitrum`: `l1Address()` is `l1Address` and `l2Gateway()` is `gateway`.
 */
export interface BridgeLink {
  kind: 'op-stack' | 'arbitrum';
  l1Address: string;
  gateway: string;
}

/**
 * Written reason why a `bridged` token has no checkable `BridgeLink` (its gateway is not a
 * standard one), with the on-chain fact that stands in for it: `verify:tokens` checks that
 * `wards(ward)` on the token is 1, i.e. the named gateway may mint it (Maker-style auth).
 */
export interface BridgeExemption {
  reason: string;
  /** Lowercase gateway address that must be a ward (minter) of the token. */
  ward: string;
}

/**
 * A curated entry: the public `TokenInfo` plus verification data that is never served to
 * clients (the API copies public fields one by one).
 */
export interface CuratedToken extends TokenInfo {
  /** On-chain `symbol()` when the display symbol differs (e.g. `USD₮0` for USDT0). */
  onchainSymbol?: string;
  bridge?: BridgeLink;
  /** For a `bridged` token without `bridge`: why, and the ward check that replaces it. */
  bridgeExemption?: BridgeExemption;
}

/**
 * Curated token list (ADR 0006). Checked-in data, never fetched at runtime, deep-frozen.
 *
 * Adding, changing or removing an entry follows docs/runbooks/token-list.md, which also holds
 * each token's sources, verification date and risk record (issuer powers such as upgrades,
 * pausing, blacklisting or minting, and the decision that accepted them). Every change runs
 * `pnpm --filter @ranvier/chains verify:tokens` and goes to the security reviewer: `decimals`
 * here are trusted input to fee tiers and route vetting, and become `knownDecimals` in the
 * chain registry. The `stablecoin` tag must match the registry's `stablecoins` (fee data).
 *
 * Rules: EVM addresses lowercase; the native coin spelled `native`; one entry per address and
 * per symbol on a chain; no rebasing or fee-on-transfer tokens (the fee wrapper refuses them).
 * Solana is not listed yet.
 */
/** Coinbase Wrapped BTC: one address on Ethereum, Base and Arbitrum One. */
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

const native = (chain: ChainKey, symbol: string, name: string, decimals: number): CuratedToken => ({
  chain,
  address: 'native',
  symbol,
  name,
  decimals,
  tags: ['native'],
});

export const TOKEN_LIST: readonly CuratedToken[] = deepFreeze<CuratedToken[]>([
  // Ethereum
  native('evm:1', 'ETH', 'Ether', 18),
  {
    chain: 'evm:1',
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    tags: ['wrapped-native'],
  },
  {
    chain: 'evm:1',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    tags: ['stablecoin'],
  },
  {
    chain: 'evm:1',
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    tags: ['stablecoin'],
  },
  {
    chain: 'evm:1',
    address: '0x6b175474e89094c44da98b954eedeac495271d0f',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    tags: ['stablecoin'],
  },
  {
    chain: 'evm:1',
    address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    decimals: 8,
  },
  {
    chain: 'evm:1',
    address: '0x514910771af9ca656af840dff83e8264ecf986ca',
    symbol: 'LINK',
    name: 'ChainLink Token',
    decimals: 18,
  },
  {
    chain: 'evm:1',
    address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
  },
  {
    chain: 'evm:1',
    address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
    symbol: 'AAVE',
    name: 'Aave Token',
    decimals: 18,
  },

  {
    chain: 'evm:1',
    address: CBBTC,
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
  },

  // Base
  native('evm:8453', 'ETH', 'Ether', 18),
  {
    chain: 'evm:8453',
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    tags: ['wrapped-native'],
  },
  {
    chain: 'evm:8453',
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    tags: ['stablecoin'],
  },
  {
    chain: 'evm:8453',
    address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    tags: ['stablecoin', 'bridged'],
    bridge: {
      kind: 'op-stack',
      l1Address: '0x6b175474e89094c44da98b954eedeac495271d0f',
      gateway: OP_STANDARD_BRIDGE,
    },
  },
  {
    chain: 'evm:8453',
    address: '0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196',
    symbol: 'LINK',
    name: 'ChainLink Token',
    decimals: 18,
  },
  {
    chain: 'evm:8453',
    address: '0xc3de830ea07524a0761646a6a4e4be0e114a3c83',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    tags: ['bridged'],
    bridge: {
      kind: 'op-stack',
      l1Address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      gateway: OP_STANDARD_BRIDGE,
    },
  },
  {
    chain: 'evm:8453',
    address: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
    symbol: 'AERO',
    name: 'Aerodrome',
    decimals: 18,
  },

  {
    chain: 'evm:8453',
    address: CBBTC,
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
  },

  // Arbitrum One
  native('evm:42161', 'ETH', 'Ether', 18),
  {
    chain: 'evm:42161',
    address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    tags: ['wrapped-native'],
    bridge: {
      kind: 'arbitrum',
      l1Address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      gateway: ARB_WETH_GATEWAY,
    },
  },
  {
    chain: 'evm:42161',
    address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    tags: ['stablecoin'],
  },
  {
    // Tether's USDT on Arbitrum (migrated to USDT0 at the same address); on-chain symbol USD₮0.
    chain: 'evm:42161',
    address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    symbol: 'USDT0',
    onchainSymbol: 'USD₮0',
    name: 'USD₮0',
    decimals: 6,
    tags: ['stablecoin'],
  },
  {
    chain: 'evm:42161',
    address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    tags: ['stablecoin', 'bridged'],
    bridgeExemption: {
      reason:
        "Bridged by Maker's custom Dai gateway, which has no l1Address()/l2Gateway(); the " +
        'gateway is a ward (minter) of the token and its l1Dai() is L1 DAI',
      ward: ARB_DAI_GATEWAY,
    },
  },
  {
    chain: 'evm:42161',
    address: '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    decimals: 8,
    tags: ['bridged'],
    bridge: {
      kind: 'arbitrum',
      l1Address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
      gateway: ARB_STANDARD_GATEWAY,
    },
  },
  {
    chain: 'evm:42161',
    address: '0xf97f4df75117a78c1a5a0dbb814af92458539fb4',
    symbol: 'LINK',
    name: 'ChainLink Token',
    decimals: 18,
    tags: ['bridged'],
    bridge: {
      kind: 'arbitrum',
      l1Address: '0x514910771af9ca656af840dff83e8264ecf986ca',
      gateway: ARB_STANDARD_GATEWAY,
    },
  },
  {
    chain: 'evm:42161',
    address: '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    tags: ['bridged'],
    bridge: {
      kind: 'arbitrum',
      l1Address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      gateway: ARB_STANDARD_GATEWAY,
    },
  },
  {
    chain: 'evm:42161',
    address: '0x912ce59144191c1204e64559fe8253a0e49e6548',
    symbol: 'ARB',
    name: 'Arbitrum',
    decimals: 18,
  },
  {
    chain: 'evm:42161',
    address: CBBTC,
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
  },
]);

const hasTag = (token: TokenInfo, tag: TokenTag): boolean => token.tags?.includes(tag) ?? false;

/**
 * Natives first, then stablecoins, then the rest; by case-insensitive symbol (unique per chain)
 * within a group.
 */
function rank(token: TokenInfo): number {
  if (hasTag(token, 'native')) return 0;
  if (hasTag(token, 'stablecoin')) return 1;
  return 2;
}

function compareTokens(a: TokenInfo, b: TokenInfo): number {
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const x = a.symbol.toLowerCase();
  const y = b.symbol.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The curated tokens of a chain in display order. Empty for a chain with no list. */
export function listTokens(chain: ChainKey): readonly CuratedToken[] {
  return TOKEN_LIST.filter((t) => t.chain === chain).sort(compareTokens);
}

/**
 * Checked-in decimals of every listed non-native token of a chain, keyed by address. The chain
 * registry's `knownDecimals` is derived from this, so the token list is the single source.
 */
export function listedDecimals(chain: ChainKey): Record<string, number> {
  return Object.fromEntries(
    TOKEN_LIST.filter((t) => t.chain === chain && t.address !== 'native').map((t) => [
      t.address,
      t.decimals,
    ]),
  );
}

const FULL_EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Name matches need at least this many characters, so one letter does not match every name. */
export const MIN_NAME_QUERY_LENGTH = 2;

/**
 * Searches a chain's curated tokens. An empty query returns the whole list. A full EVM address
 * matches that address exactly (any case); partial addresses match nothing. Any other query
 * matches symbols by case-insensitive substring and, from two characters, names as well.
 * Results keep display order.
 */
export function searchTokens(chain: ChainKey, query: string, limit: number): CuratedToken[] {
  const tokens = listTokens(chain);
  const q = query.trim().toLowerCase();
  let matches: readonly CuratedToken[];
  if (q === '') {
    matches = tokens;
  } else if (FULL_EVM_ADDRESS.test(q)) {
    matches = tokens.filter((t) => t.address.toLowerCase() === q);
  } else {
    matches = tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        (q.length >= MIN_NAME_QUERY_LENGTH && t.name.toLowerCase().includes(q)),
    );
  }
  return matches.slice(0, Math.max(0, limit));
}

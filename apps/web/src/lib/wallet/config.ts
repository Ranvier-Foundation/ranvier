import { createConfig, custom, type Config } from 'wagmi';
import type { Chain } from 'viem';
import { EVM_CHAINS, toWagmiChain } from './chains';

/**
 * Transport that refuses every request. This PR makes no chain reads from the browser: the wallet
 * itself answers connection and chain queries, and the CSP does not allow RPC origins. When
 * balances and quotes arrive they will replace this with a real transport.
 */
const noRpc = custom({
  request: () => Promise.reject(new Error('This app does not read the chain directly yet')),
});

/**
 * The wagmi config: chains from the registry, browser wallets found through EIP-6963 (wagmi's
 * built-in discovery, no connectors listed by hand), no RPC transport. `ssr: true` makes wagmi
 * skip hydrating persisted state during the first render, so server and client markup match.
 * wagmi's default storage (localStorage, keys prefixed `wagmi.`) keeps the connection preference.
 */
export function createWalletConfig(): Config {
  const [first, ...rest] = EVM_CHAINS.map(toWagmiChain);
  if (!first) throw new Error('The chain registry lists no EVM chain');
  const chains: readonly [Chain, ...Chain[]] = [first, ...rest];
  return createConfig({
    chains,
    transports: Object.fromEntries(chains.map((c) => [c.id, noRpc])),
    ssr: true,
    multiInjectedProviderDiscovery: true,
  });
}

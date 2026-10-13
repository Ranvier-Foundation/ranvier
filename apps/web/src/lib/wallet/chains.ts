import { CHAINS, type ChainConfig } from '@ranvier/chains';
import { defineChain, type Chain } from 'viem';

/** EVM chains the registry lists, in registry order (the first is the default network). */
export const EVM_CHAINS: readonly ChainConfig[] = CHAINS.filter((c) => c.family === 'evm');

/** Numeric EVM chain id from a registry key such as `evm:8453`, or undefined for other families. */
export function evmChainId(chain: ChainConfig): number | undefined {
  const match = /^evm:(\d{1,10})$/.exec(chain.key);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The registry chain a wallet's chain id refers to, or undefined when Ranvier does not list it. */
export function registryChainByWalletId(id: number | undefined): ChainConfig | undefined {
  if (id === undefined) return undefined;
  return EVM_CHAINS.find((c) => evmChainId(c) === id);
}

/**
 * The wagmi/viem chain for a registry chain. Id, name, native symbol and explorer all come from
 * the registry. No RPC URL: the app makes no chain reads of its own yet (the wallet does them).
 */
export function toWagmiChain(chain: ChainConfig): Chain {
  const id = evmChainId(chain);
  if (id === undefined) throw new Error(`${chain.key} is not an EVM chain`);
  return defineChain({
    id,
    name: chain.name,
    nativeCurrency: {
      name: chain.nativeSymbol,
      symbol: chain.nativeSymbol,
      decimals: chain.nativeDecimals,
    },
    rpcUrls: { default: { http: [] } },
    blockExplorers: { default: { name: chain.name, url: chain.explorer } },
  });
}

/** Explorer page for an address on a registry chain. */
export function explorerAddressUrl(chain: ChainConfig, address: string): string {
  return `${chain.explorer}/address/${address}`;
}

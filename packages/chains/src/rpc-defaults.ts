import type { ChainKey } from '@ranvier/types';
import { deepFreeze } from './freeze.js';

/**
 * Public, keyless RPC endpoints, for development and for the manual networked scripts
 * (`verify:tokens`, `balances:smoke`) only. Server code only: the browser never talks to an RPC
 * provider (ADR 0008, ADR 0009).
 *
 * Not for production. They are rate-limited, carry no service agreement, and their logging
 * policies are not ours to choose: every balance read reveals the wallet address to the
 * provider. Production sets `RPC_URLS_EVM_<chainId>` to providers with a no-logging policy
 * (docs/runbooks/rpc-providers.md). The API logs a warning at startup for every chain that
 * falls back to these.
 */
export const PUBLIC_RPC_URLS: Readonly<Partial<Record<ChainKey, readonly string[]>>> = deepFreeze<
  Partial<Record<ChainKey, string[]>>
>({
  'evm:1': ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth'],
  'evm:8453': ['https://base-rpc.publicnode.com', 'https://1rpc.io/base'],
  'evm:42161': ['https://arbitrum-one-rpc.publicnode.com', 'https://1rpc.io/arb'],
});

import { PUBLIC_RPC_URLS } from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import type { RpcEndpointConfig } from './adapters/rpc/viem-chain-reader.js';

/**
 * RPC endpoints for balance reads (ADR 0009, docs/runbooks/rpc-providers.md).
 *
 * `RPC_URLS_EVM_<chainId>` holds comma-separated URLs, in preference order. URLs usually carry
 * an API key, so no error, log line or response ever contains one: errors name the variable
 * and the entry number only. A chain without the variable uses the public development
 * endpoints in `@ranvier/chains` (`PUBLIC_RPC_URLS`), and startup logs a warning naming the
 * chain.
 */

export const RPC_ENV_PREFIX = 'RPC_URLS_EVM_';
/** Endpoints per chain; more adds little and multiplies ranking traffic. */
export const MAX_RPC_URLS_PER_CHAIN = 8;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface RpcConfig {
  endpoints: Map<number, RpcEndpointConfig[]>;
  /** Chains that fell back to public development endpoints. */
  publicDefaultChains: number[];
  /** `RPC_URLS_EVM_*` variables for chains balances are not offered on (names only). */
  ignored: string[];
}

export const rpcEnvName = (chainId: number): string => `${RPC_ENV_PREFIX}${chainId}`;

/**
 * Parses one variable. https only; plain http only for a loopback host (a local node or fork).
 * Refuses an empty entry, a duplicate, more than eight entries, or anything that is not a URL.
 */
export function parseRpcUrlList(name: string, raw: string): string[] {
  const entries = raw.split(',').map((e) => e.trim());
  if (entries.length > MAX_RPC_URLS_PER_CHAIN) {
    throw new Error(`${name} lists more than ${MAX_RPC_URLS_PER_CHAIN} URLs`);
  }
  const urls: string[] = [];
  entries.forEach((entry, i) => {
    const where = `${name} entry ${i + 1}`;
    if (entry === '') throw new Error(`${where} is empty`);
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${where} is not a valid URL (value not shown)`);
    }
    if (url.protocol === 'http:') {
      if (!LOOPBACK_HOSTS.has(url.hostname)) {
        throw new Error(`${where} must use https unless the host is loopback (value not shown)`);
      }
    } else if (url.protocol !== 'https:') {
      throw new Error(`${where} must be an https URL (value not shown)`);
    }
    if (url.hash !== '') throw new Error(`${where} must not have a fragment (value not shown)`);
    if (urls.includes(entry)) throw new Error(`${where} repeats an earlier entry`);
    urls.push(entry);
  });
  return urls;
}

/**
 * Endpoints for every chain in `chainIds` (served EVM chains with a token list). Throws on an
 * invalid variable for any chain, or a variable whose name is not `RPC_URLS_EVM_<chainId>`, so a
 * typo fails startup instead of silently using public defaults.
 */
export function loadRpcConfig(
  env: Readonly<Record<string, string | undefined>>,
  chainIds: readonly number[],
  defaults: Readonly<Partial<Record<ChainKey, readonly string[]>>> = PUBLIC_RPC_URLS,
): RpcConfig {
  const wanted = new Set(chainIds);
  const ignored: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(RPC_ENV_PREFIX)) continue;
    const suffix = name.slice(RPC_ENV_PREFIX.length);
    if (!/^[1-9]\d{0,9}$/.test(suffix)) {
      throw new Error(`${name} is not a valid name: expected ${RPC_ENV_PREFIX}<chain ID>`);
    }
    if (!wanted.has(Number(suffix))) ignored.push(name);
  }
  const endpoints = new Map<number, RpcEndpointConfig[]>();
  const publicDefaultChains: number[] = [];
  for (const chainId of wanted) {
    const name = rpcEnvName(chainId);
    const raw = env[name]?.trim();
    if (raw) {
      endpoints.set(
        chainId,
        parseRpcUrlList(name, raw).map((url, i) => ({ url, label: `${name}[${i}]` })),
      );
      continue;
    }
    const fallback = defaults[`evm:${chainId}`];
    if (fallback && fallback.length > 0) {
      publicDefaultChains.push(chainId);
      endpoints.set(
        chainId,
        fallback.map((url, i) => ({ url, label: `public-default:${chainId}[${i}]` })),
      );
    }
  }
  return { endpoints, publicDefaultChains, ignored };
}

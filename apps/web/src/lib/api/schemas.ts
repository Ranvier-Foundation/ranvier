import type { ChainFamily, ChainKey, TokenTag } from '@ranvier/types';

/**
 * Validators for every API response the browser reads (ADR 0006, ADR 0009). Each one takes
 * `unknown` and returns a typed value or throws `SchemaError`; an answer that does not match
 * exactly is refused whole, never repaired or partly shown. Text from the API is only ever data:
 * it is length-bounded, stripped of control and bidirectional-override characters (a refusal if
 * present) and rendered as React text. It is never used as a URL, `src`, `href` or markup.
 * `logoUri` is read to check its type and then dropped: no image is loaded from an API string.
 * No schema library: the shapes are small, and the web app takes no new dependency for them.
 */

export class SchemaError extends Error {
  constructor(path: string) {
    super(`invalid API response at ${path}`);
    this.name = 'SchemaError';
  }
}

type Json = Record<string, unknown>;

function record(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaError(path);
  }
  return value as Json;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new SchemaError(path);
  return value;
}

/**
 * Control characters, format characters (bidirectional overrides and isolates, zero-width
 * marks) and line or paragraph separators: none may appear in text we display.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Display text: a non-empty string of at most `max` characters with no unsafe characters. */
function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new SchemaError(path);
  }
  if (UNSAFE_TEXT.test(value) || value.trim() !== value) throw new SchemaError(path);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new SchemaError(path);
  return value;
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SchemaError(path);
  }
  return value;
}

const CHAIN_KEY = /^(?:evm:[1-9]\d{0,9}|solana:mainnet)$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const TOKEN_TAGS: ReadonlySet<string> = new Set<TokenTag>([
  'native',
  'wrapped-native',
  'stablecoin',
  'bridged',
]);
const MAX_UINT256 = 2n ** 256n - 1n;

export function chainKey(value: unknown, path: string): ChainKey {
  if (typeof value !== 'string' || !CHAIN_KEY.test(value)) throw new SchemaError(path);
  return value as ChainKey;
}

/** `native` or a lowercase 20-byte EVM address (the only token addresses the API serves today). */
function tokenAddress(value: unknown, path: string): string {
  if (typeof value !== 'string' || (value !== 'native' && !EVM_ADDRESS.test(value))) {
    throw new SchemaError(path);
  }
  return value;
}

/** What the picker reads of `GET /v1/chains`. Explorer URLs are not read: nothing links to them. */
export interface ApiChain {
  key: ChainKey;
  name: string;
  family: ChainFamily;
  nativeSymbol: string;
  /** True when the API can read balances on this chain right now (ADR 0009). */
  balances: boolean;
}

export const MAX_CHAINS = 64;
export const MAX_TOKENS = 100;

export function parseChains(json: unknown): ApiChain[] {
  const seen = new Set<string>();
  return list(json, '(body)', MAX_CHAINS).map((raw, i) => {
    const o = record(raw, `[${i}]`);
    const key = chainKey(o['key'], `[${i}].key`);
    if (seen.has(key)) throw new SchemaError(`[${i}].key`);
    seen.add(key);
    const family = o['family'];
    if (family !== 'evm' && family !== 'solana') throw new SchemaError(`[${i}].family`);
    // Read for type only: they are part of the contract, but the picker does not use them.
    int(o['nativeDecimals'], `[${i}].nativeDecimals`, 0, 36);
    bool(o['quoting'], `[${i}].quoting`);
    return {
      key,
      name: text(o['name'], `[${i}].name`, 32),
      family,
      nativeSymbol: text(o['nativeSymbol'], `[${i}].nativeSymbol`, 16),
      balances: bool(o['balances'], `[${i}].balances`),
    };
  });
}

/** What the picker reads of `GET /v1/tokens`. */
export interface ApiToken {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  tags: readonly TokenTag[];
}

/** Tokens for one chain. Every token must belong to `chain`; addresses must be unique. */
export function parseTokens(json: unknown, chain: ChainKey): ApiToken[] {
  const seen = new Set<string>();
  return list(json, '(body)', MAX_TOKENS).map((raw, i) => {
    const o = record(raw, `[${i}]`);
    if (chainKey(o['chain'], `[${i}].chain`) !== chain) throw new SchemaError(`[${i}].chain`);
    const address = tokenAddress(o['address'], `[${i}].address`);
    if (seen.has(address)) throw new SchemaError(`[${i}].address`);
    seen.add(address);
    const logoUri = o['logoUri'];
    if (logoUri !== undefined && typeof logoUri !== 'string')
      throw new SchemaError(`[${i}].logoUri`);
    const rawTags = list(o['tags'], `[${i}].tags`, 8);
    for (const tag of rawTags) if (typeof tag !== 'string') throw new SchemaError(`[${i}].tags`);
    return {
      chain,
      address,
      symbol: text(o['symbol'], `[${i}].symbol`, 32),
      name: text(o['name'], `[${i}].name`, 64),
      decimals: int(o['decimals'], `[${i}].decimals`, 0, 36),
      // A tag this build does not know is ignored, not refused: tags only order and label rows.
      tags: (rawTags as string[]).filter((tag): tag is TokenTag => TOKEN_TAGS.has(tag)),
    };
  });
}

/** Balances of one wallet on one chain: token address (or `native`) to base units, or null. */
export interface ApiBalances {
  chain: ChainKey;
  byAddress: ReadonlyMap<string, bigint | null>;
}

/**
 * The answer to `POST /v1/balances`. It must name the chain and wallet that were asked for (the
 * address is compared in lowercase, as the API returns it). Balances are display data only.
 */
export function parseBalances(json: unknown, chain: ChainKey, wallet: string): ApiBalances {
  const o = record(json, '(body)');
  if (chainKey(o['chain'], 'chain') !== chain) throw new SchemaError('chain');
  if (typeof o['address'] !== 'string' || o['address'].toLowerCase() !== wallet.toLowerCase()) {
    throw new SchemaError('address');
  }
  if (typeof o['blockNumber'] !== 'string' || !/^\d{1,16}$/.test(o['blockNumber'])) {
    throw new SchemaError('blockNumber');
  }
  const byAddress = new Map<string, bigint | null>();
  for (const [i, raw] of list(o['balances'], 'balances', MAX_TOKENS + 1).entries()) {
    const b = record(raw, `balances[${i}]`);
    const address = tokenAddress(b['address'], `balances[${i}].address`);
    if (byAddress.has(address)) throw new SchemaError(`balances[${i}].address`);
    const balance = b['balance'];
    if (balance === null) {
      byAddress.set(address, null);
      continue;
    }
    if (typeof balance !== 'string' || !/^(?:0|[1-9]\d{0,77})$/.test(balance)) {
      throw new SchemaError(`balances[${i}].balance`);
    }
    const value = BigInt(balance);
    if (value > MAX_UINT256) throw new SchemaError(`balances[${i}].balance`);
    byAddress.set(address, value);
  }
  return { chain, byAddress };
}

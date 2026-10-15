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

export type Json = Record<string, unknown>;

export function record(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaError(path);
  }
  return value as Json;
}

export function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new SchemaError(path);
  return value;
}

/**
 * Control characters, format characters (bidirectional overrides and isolates, zero-width
 * marks) and line or paragraph separators: none may appear in text we display.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Display text: a non-empty string of at most `max` characters with no unsafe characters. */
export function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new SchemaError(path);
  }
  if (UNSAFE_TEXT.test(value) || value.trim() !== value) throw new SchemaError(path);
  return value;
}

/**
 * Token symbols are ASCII only: letters, digits, `.`, `+` and `-`, 1 to 32 characters. That
 * refuses look-alike scripts (Cyrillic, Greek), fullwidth forms, mathematical alphanumerics,
 * blank-rendering characters (Hangul filler, braille blank), combining marks and every kind of
 * space, because a symbol is what a user reads to tell tokens apart (ADR 0010).
 */
const TOKEN_SYMBOL = /^[A-Za-z0-9.+-]{1,32}$/;

export function tokenSymbol(value: unknown, path: string): string {
  if (typeof value !== 'string' || !TOKEN_SYMBOL.test(value)) throw new SchemaError(path);
  return value;
}

/**
 * Token names may use letters and the few symbols real names need, from one writing system.
 * Allowed characters, and nothing else: letters (`\p{L}`), currency signs (`\p{Sc}`, for names such
 * as `USD₮0`) and printable ASCII (digits, punctuation, the space). So refused are: combining
 * marks (`\p{M}`, no stacking), every space but U+0020 (no-break, ideographic, thin), non-ASCII
 * digits, braille blanks and other symbols, and emoji. Markup characters are allowed: names are
 * only ever rendered as text. Further:
 * - a double space is refused (a run of spaces reads as blank);
 * - blank-rendering letters (Unicode `Default_Ignorable_Code_Point`: Hangul fillers U+115F,
 *   U+1160, U+3164, U+FFA0, Khmer inherent vowels, variation selectors) are refused;
 * - the text must be stable under NFKC, which refuses fullwidth forms, mathematical
 *   alphanumerics, ligatures and other compatibility look-alikes;
 * - all letters come from one writing system: Latin (Basic Latin, Latin-1 Supplement and Latin
 *   Extended-A only, which leaves out IPA and click letters), Greek, Cyrillic, Hebrew, Arabic,
 *   Hangul, or Japanese (Han, Hiragana and Katakana together). Letters of any other script are
 *   refused, so `USD Сoin` (Cyrillic С) fails.
 * Control, format (bidirectional, zero-width) and separator characters, and padding, are refused
 * first by `text`. A name written wholly in one script (all-Cyrillic `СОРА`) can still resemble
 * another word; the row's short address tells such tokens apart (ADR 0010).
 */
const NAME_CHARS = /^[\p{L}\p{Sc}\u0020-\u007E]+$/u;
const BLANK_RENDERING = /\p{Default_Ignorable_Code_Point}/u;
const LETTER = /\p{L}/u;
const LETTER_SYSTEMS: readonly (readonly [string, RegExp])[] = [
  ['latin', /^[A-Za-z\u00C0-\u00FF\u0100-\u017F]$/],
  ['greek', /^\p{scx=Greek}$/u],
  ['cyrillic', /^\p{scx=Cyrillic}$/u],
  ['hebrew', /^\p{scx=Hebrew}$/u],
  ['arabic', /^\p{scx=Arabic}$/u],
  ['hangul', /^\p{scx=Hangul}$/u],
  ['japanese', /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]$/u],
];

export function tokenName(value: unknown, path: string, max: number): string {
  const name = text(value, path, max);
  if (
    !NAME_CHARS.test(name) ||
    BLANK_RENDERING.test(name) ||
    name.includes('  ') ||
    name.normalize('NFKC') !== name
  ) {
    throw new SchemaError(path);
  }
  let system: string | undefined;
  for (const ch of name) {
    if (!LETTER.test(ch)) continue;
    const found = LETTER_SYSTEMS.find(([, re]) => re.test(ch));
    if (!found || (system !== undefined && system !== found[0])) throw new SchemaError(path);
    system = found[0];
  }
  return name;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new SchemaError(path);
  return value;
}

export function int(value: unknown, path: string, min: number, max: number): number {
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

/** What the app reads of `GET /v1/chains`. Explorer URLs are not read: nothing links to them. */
export interface ApiChain {
  key: ChainKey;
  name: string;
  family: ChainFamily;
  nativeSymbol: string;
  /** True when the API can read balances on this chain right now (ADR 0009). */
  balances: boolean;
  /** True when the API can quote swaps on this chain right now (routing configured, ADR 0006). */
  quoting: boolean;
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
    // Read for type only: part of the contract, but nothing uses it.
    int(o['nativeDecimals'], `[${i}].nativeDecimals`, 0, 36);
    return {
      key,
      name: text(o['name'], `[${i}].name`, 32),
      family,
      nativeSymbol: text(o['nativeSymbol'], `[${i}].nativeSymbol`, 16),
      balances: bool(o['balances'], `[${i}].balances`),
      quoting: bool(o['quoting'], `[${i}].quoting`),
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

/**
 * Tokens for one chain. Every token must belong to `chain`; addresses and symbols (compared
 * without case) must be unique within the answer.
 */
export function parseTokens(json: unknown, chain: ChainKey): ApiToken[] {
  const seen = new Set<string>();
  const symbols = new Set<string>();
  return list(json, '(body)', MAX_TOKENS).map((raw, i) => {
    const o = record(raw, `[${i}]`);
    if (chainKey(o['chain'], `[${i}].chain`) !== chain) throw new SchemaError(`[${i}].chain`);
    const address = tokenAddress(o['address'], `[${i}].address`);
    if (seen.has(address)) throw new SchemaError(`[${i}].address`);
    seen.add(address);
    // One symbol per chain, compared without case: two rows that read the same cannot be told apart.
    const symbol = tokenSymbol(o['symbol'], `[${i}].symbol`);
    const symbolKey = symbol.toUpperCase();
    if (symbols.has(symbolKey)) throw new SchemaError(`[${i}].symbol`);
    symbols.add(symbolKey);
    const logoUri = o['logoUri'];
    if (logoUri !== undefined && typeof logoUri !== 'string')
      throw new SchemaError(`[${i}].logoUri`);
    const rawTags = list(o['tags'], `[${i}].tags`, 8);
    for (const tag of rawTags) if (typeof tag !== 'string') throw new SchemaError(`[${i}].tags`);
    return {
      chain,
      address,
      symbol,
      name: tokenName(o['name'], `[${i}].name`, 64),
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

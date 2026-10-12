import type { ChainKey } from '@ranvier/types';
import { getChain } from './registry.js';
import type { CuratedToken } from './tokens.js';

/**
 * Re-verification of the curated token list against the chains and DefiLlama (runbook:
 * docs/runbooks/token-list.md). Pure logic with injected I/O, so the diff is unit-tested; the
 * network runner is `verify-cli.ts` (`pnpm --filter @ranvier/chains verify:tokens`).
 */

/** 4-byte selectors (keccak256 of the signature). */
export const SELECTORS = {
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  name: '0x06fdde03',
  remoteToken: '0xd6c0b2c4',
  bridge: '0xe78cea92',
  l1Address: '0xc2eeeebd',
  l2Gateway: '0x8fa74a0e',
} as const;

/** DefiLlama confidence the API requires before it prices a token (ADR 0004). */
export const MIN_LLAMA_CONFIDENCE = 0.9;

export interface LlamaCoin {
  symbol?: string | undefined;
  decimals?: number | undefined;
  confidence?: number | undefined;
}

export interface VerifyDeps {
  /** `eth_call` of `data` on `to` at the latest block; resolves to the raw hex result. */
  ethCall: (chain: ChainKey, to: string, data: string) => Promise<string>;
  /** DefiLlama `coins` for the given `<chain>:<address>` ids (missing ids are absent). */
  llama: (ids: readonly string[]) => Promise<Readonly<Record<string, LlamaCoin>>>;
}

export interface Observed {
  onchain?: { symbol: string; name: string; decimals: number };
  llama?: LlamaCoin;
  bridge?: { l1Address: string; gateway: string };
  /** Calls that failed; a token that could not be read is not verified. */
  errors: string[];
}

export interface TokenReport {
  token: CuratedToken;
  problems: string[];
}

function words(hex: string): string {
  if (!/^0x([0-9a-fA-F]{64})+$/.test(hex)) throw new Error('malformed ABI result');
  return hex.slice(2);
}

function word(body: string, index: number): string {
  const w = body.slice(index * 64, index * 64 + 64);
  if (w.length !== 64) throw new Error('truncated ABI result');
  return w;
}

export function decodeUint(hex: string): bigint {
  return BigInt(`0x${word(words(hex), 0)}`);
}

export function decodeAddress(hex: string): string {
  const w = word(words(hex), 0);
  if (!/^0{24}/.test(w)) throw new Error('dirty address word');
  return `0x${w.slice(24).toLowerCase()}`;
}

/** A dynamic ABI `string` return: offset, length, UTF-8 bytes. */
export function decodeString(hex: string): string {
  const body = words(hex);
  const offset = Number(BigInt(`0x${word(body, 0)}`));
  if (offset % 32 !== 0) throw new Error('unaligned string offset');
  const length = Number(BigInt(`0x${word(body, offset / 32)}`));
  const start = (offset + 32) * 2;
  const data = body.slice(start, start + length * 2);
  if (data.length !== length * 2) throw new Error('truncated string');
  const bytes = Uint8Array.from(data.match(/../g) ?? [], (b) => parseInt(b, 16));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Every difference between a list entry and what the chain and DefiLlama report. */
export function diffToken(t: CuratedToken, o: Observed): string[] {
  const problems = [...o.errors];
  if (o.onchain) {
    const symbol = t.onchainSymbol ?? t.symbol;
    if (o.onchain.symbol !== symbol) {
      problems.push(`on-chain symbol ${JSON.stringify(o.onchain.symbol)}, list ${symbol}`);
    }
    if (o.onchain.name !== t.name) {
      problems.push(`on-chain name ${JSON.stringify(o.onchain.name)}, list ${t.name}`);
    }
    if (o.onchain.decimals !== t.decimals) {
      problems.push(`on-chain decimals ${o.onchain.decimals}, list ${t.decimals}`);
    }
  } else if (o.errors.length === 0) {
    problems.push('no on-chain metadata');
  }
  if (!o.llama) {
    problems.push('no DefiLlama entry');
  } else {
    if (o.llama.symbol?.toLowerCase() !== t.symbol.toLowerCase()) {
      problems.push(`DefiLlama symbol ${JSON.stringify(o.llama.symbol)}, list ${t.symbol}`);
    }
    if (o.llama.decimals !== t.decimals) {
      problems.push(`DefiLlama decimals ${String(o.llama.decimals)}, list ${t.decimals}`);
    }
    if (o.llama.confidence === undefined || o.llama.confidence < MIN_LLAMA_CONFIDENCE) {
      problems.push(`DefiLlama confidence ${String(o.llama.confidence)} < ${MIN_LLAMA_CONFIDENCE}`);
    }
  }
  if (t.bridge) {
    if (!o.bridge) {
      if (o.errors.length === 0) problems.push('bridge link not read');
    } else {
      if (o.bridge.l1Address !== t.bridge.l1Address) {
        problems.push(`bridge L1 ${o.bridge.l1Address}, list ${t.bridge.l1Address}`);
      }
      if (o.bridge.gateway !== t.bridge.gateway) {
        problems.push(`bridge gateway ${o.bridge.gateway}, list ${t.bridge.gateway}`);
      }
    }
  }
  return problems;
}

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 200);

async function observe(
  t: CuratedToken,
  deps: VerifyDeps,
  llama: Readonly<Record<string, LlamaCoin>>,
  llamaId: string,
): Promise<Observed> {
  const observed: Observed = { errors: [] };
  const coin = llama[llamaId];
  if (coin) observed.llama = coin;
  try {
    const [symbol, name, decimals] = await Promise.all([
      deps.ethCall(t.chain, t.address, SELECTORS.symbol).then(decodeString),
      deps.ethCall(t.chain, t.address, SELECTORS.name).then(decodeString),
      deps.ethCall(t.chain, t.address, SELECTORS.decimals).then(decodeUint),
    ]);
    observed.onchain = { symbol, name, decimals: Number(decimals) };
  } catch (err: unknown) {
    observed.errors.push(`metadata: ${errText(err)}`);
  }
  if (t.bridge) {
    const [l1Sel, gwSel] =
      t.bridge.kind === 'op-stack'
        ? [SELECTORS.remoteToken, SELECTORS.bridge]
        : [SELECTORS.l1Address, SELECTORS.l2Gateway];
    try {
      const [l1Address, gateway] = await Promise.all([
        deps.ethCall(t.chain, t.address, l1Sel).then(decodeAddress),
        deps.ethCall(t.chain, t.address, gwSel).then(decodeAddress),
      ]);
      observed.bridge = { l1Address, gateway };
    } catch (err: unknown) {
      observed.errors.push(`bridge: ${errText(err)}`);
    }
  }
  return observed;
}

/**
 * Checks every non-native entry. Natives are checked by the unit tests against the registry.
 * A token whose reads fail is reported, never passed.
 */
export async function verifyTokens(
  list: readonly CuratedToken[],
  deps: VerifyDeps,
): Promise<TokenReport[]> {
  const tokens = list.filter((t) => t.address !== 'native');
  const idOf = (t: CuratedToken): string =>
    `${getChain(t.chain)?.defillama ?? t.chain}:${t.address}`;
  let llama: Readonly<Record<string, LlamaCoin>> = {};
  let llamaError: string | undefined;
  try {
    llama = await deps.llama(tokens.map(idOf));
  } catch (err: unknown) {
    llamaError = `DefiLlama: ${errText(err)}`;
  }
  const reports: TokenReport[] = [];
  for (const token of tokens) {
    const observed = await observe(token, deps, llama, idOf(token));
    if (llamaError) observed.errors.push(llamaError);
    reports.push({ token, problems: diffToken(token, observed) });
  }
  return reports;
}

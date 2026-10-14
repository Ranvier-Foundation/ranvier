import type { ChainKey } from '@ranvier/types';
import type { ApiChain, ApiToken } from '@/lib/api/schemas';

/** What is known about a wallet's balances on one chain. Display data only (ADR 0009). */
export type ChainBalances =
  | { status: 'loading' }
  | { status: 'error' }
  /** The API says it cannot read this chain right now (`balances: false`). */
  | { status: 'unavailable' }
  | { status: 'ready'; byAddress: ReadonlyMap<string, bigint | null> };

export type RowBalance =
  | { state: 'loading' }
  | { state: 'known'; amount: bigint }
  /** Not shown: no wallet, a failed read, or a token missing from the answer. */
  | { state: 'unknown' };

export interface PickerRow {
  key: string;
  token: ApiToken;
  chain: ApiChain;
  balance: RowBalance;
}

export interface Sections {
  /** Tokens the wallet holds (balance above zero), in list order. */
  held: PickerRow[];
  other: PickerRow[];
}

/**
 * Rows for the tokens, in the order the API gave them (native coin, stablecoins, then the rest by
 * symbol; chains in registry order). `walletAddress` is set only when a wallet is connected: with
 * none, no row shows a balance. A chain whose balances have not answered yet shows a placeholder.
 */
export function buildRows(
  tokens: readonly ApiToken[],
  chains: readonly ApiChain[],
  balances: ReadonlyMap<ChainKey, ChainBalances>,
  walletAddress: string | undefined,
): PickerRow[] {
  const byKey = new Map(chains.map((c) => [c.key, c]));
  return tokens.flatMap((token) => {
    const chain = byKey.get(token.chain);
    if (!chain) return [];
    return [
      {
        key: `${token.chain}:${token.address}`,
        token,
        chain,
        balance: rowBalance(token, balances.get(token.chain), walletAddress),
      },
    ];
  });
}

function rowBalance(
  token: ApiToken,
  chain: ChainBalances | undefined,
  walletAddress: string | undefined,
): RowBalance {
  if (walletAddress === undefined) return { state: 'unknown' };
  if (chain === undefined || chain.status === 'loading') return { state: 'loading' };
  if (chain.status !== 'ready') return { state: 'unknown' };
  const amount = chain.byAddress.get(token.address);
  return typeof amount === 'bigint' ? { state: 'known', amount } : { state: 'unknown' };
}

export function splitSections(rows: readonly PickerRow[]): Sections {
  const held: PickerRow[] = [];
  const other: PickerRow[] = [];
  for (const row of rows) {
    if (row.balance.state === 'known' && row.balance.amount > 0n) held.push(row);
    else other.push(row);
  }
  return { held, other };
}

/** Quick picks: the chain's native coin and its stablecoins, from the tags the API sends. */
export function quickPicks(tokens: readonly ApiToken[]): ApiToken[] {
  return tokens.filter((t) => t.tags.includes('native') || t.tags.includes('stablecoin'));
}

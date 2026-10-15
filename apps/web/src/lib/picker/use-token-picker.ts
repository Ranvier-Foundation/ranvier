'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ChainKey } from '@ranvier/types';
import { fetchTokens, isAbort, type ApiErrorKind } from '@/lib/api/client';
import type { ApiToken } from '@/lib/api/schemas';
import type { ChainBalances } from './model';
import { normaliseQuery } from './search';
import { useBalances } from './use-balances';
import { errorKind, useChains, type ChainsState } from './use-chains';

export type { ChainsState };

/** "All networks" or one chain. */
export type Selection = 'all' | ChainKey;

export type TokensState =
  | { status: 'loading' }
  | { status: 'error'; kind: ApiErrorKind }
  | { status: 'ready'; tokens: readonly ApiToken[] };

/** How long typing must pause before the search is sent. */
export const SEARCH_DEBOUNCE_MS = 200;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export interface TokenPickerData {
  chains: ChainsState;
  tokens: TokensState;
  /** The search text already sent (or being sent). Rows on screen belong to it. */
  appliedQuery: string;
  balances: ReadonlyMap<ChainKey, ChainBalances>;
  selection: Selection;
  setSelection: (selection: Selection) => void;
  query: string;
  setQuery: (query: string) => void;
  retryChains: () => void;
  retryTokens: () => void;
  retryBalances: () => void;
}

/**
 * Everything the picker reads from the API: the chains, the tokens of the chosen chain (or of all
 * of them) for the search text, and the connected wallet's balances. Every request has its own
 * AbortController: switching chain or search text aborts the old requests, and closing the picker
 * (unmounting) aborts all of them. An answer that arrives after its request was aborted is dropped,
 * so rows never belong to a chain or search the user has left.
 */
export function useTokenPicker(walletAddress: string | undefined): TokenPickerData {
  const [selection, setSelection] = useState<Selection>('all');
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const { query: appliedQuery, searchable } = normaliseQuery(debounced, walletAddress);

  const { chains, retry: retryChains } = useChains();

  const chainList = chains.status === 'ready' ? chains.chains : undefined;
  const targets = useMemo<ChainKey[]>(
    () =>
      chainList === undefined
        ? []
        : selection === 'all'
          ? chainList.map((c) => c.key)
          : chainList.some((c) => c.key === selection)
            ? [selection]
            : [],
    [chainList, selection],
  );

  const [tokens, setTokens] = useState<{ for: Selection; state: TokensState }>({
    for: 'all',
    state: { status: 'loading' },
  });
  const [tokensAttempt, setTokensAttempt] = useState(0);
  const targetsKey = targets.join(',');
  useEffect(() => {
    if (targetsKey === '') return;
    const keys = targetsKey.split(',') as ChainKey[];
    if (!searchable) {
      setTokens({ for: selection, state: { status: 'ready', tokens: [] } });
      return;
    }
    const controller = new AbortController();
    // Same chain choice: keep the rows on screen while the new search loads. Another chain
    // choice: show the skeleton, never the old chain's rows.
    setTokens((prev) =>
      prev.for === selection && prev.state.status === 'ready'
        ? prev
        : { for: selection, state: { status: 'loading' } },
    );
    Promise.all(keys.map((key) => fetchTokens(key, appliedQuery, controller.signal)))
      .then((lists) => {
        if (controller.signal.aborted) return;
        setTokens({ for: selection, state: { status: 'ready', tokens: lists.flat() } });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbort(err)) return;
        controller.abort();
        setTokens({ for: selection, state: { status: 'error', kind: errorKind(err) } });
      });
    return () => controller.abort();
  }, [targetsKey, selection, appliedQuery, searchable, tokensAttempt]);

  const [balancesAttempt, setBalancesAttempt] = useState(0);
  const balances = useBalances(walletAddress, chainList ?? [], targets, balancesAttempt);

  // Rows from another chain choice are never shown (the effect above sets loading on a switch,
  // but the render in between must not flash them).
  const tokensState: TokensState =
    chains.status === 'ready' && targets.length === 0
      ? { status: 'ready', tokens: [] }
      : tokens.for === selection
        ? tokens.state
        : { status: 'loading' };

  return {
    chains,
    tokens: tokensState,
    appliedQuery,
    balances,
    selection,
    setSelection,
    query,
    setQuery,
    retryChains,
    retryTokens: () => setTokensAttempt((n) => n + 1),
    retryBalances: () => setBalancesAttempt((n) => n + 1),
  };
}

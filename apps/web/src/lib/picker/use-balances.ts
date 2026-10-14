'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChainKey } from '@ranvier/types';
import { fetchBalances, isAbort } from '@/lib/api/client';
import type { ApiChain } from '@/lib/api/schemas';
import type { ChainBalances } from './model';

interface Store {
  /** The wallet these answers belong to; an answer for another wallet is never kept. */
  address: string | undefined;
  byChain: ReadonlyMap<ChainKey, ChainBalances>;
}

/**
 * Balances of the connected wallet for the chains on screen, read through the API (never an RPC
 * provider). Each chain is one request, started when the chain comes on screen and aborted when
 * it leaves it, when the wallet changes, on retry and when the picker closes. A late answer for an
 * aborted request is dropped. Balances are display data only (ADR 0009).
 */
export function useBalances(
  address: string | undefined,
  chains: readonly ApiChain[],
  targets: readonly ChainKey[],
  attempt: number,
): ReadonlyMap<ChainKey, ChainBalances> {
  const [store, setStore] = useState<Store>({ address: undefined, byChain: new Map() });
  const inflight = useRef(new Map<ChainKey, AbortController>());

  // A new wallet (or a retry) starts from nothing, and stops whatever was still running.
  useEffect(() => {
    setStore({ address, byChain: new Map() });
    const running = inflight.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, [address, attempt]);

  const targetsKey = targets.join(',');
  useEffect(() => {
    if (address === undefined || store.address !== address) return;
    const running = inflight.current;
    const needed = new Set(targetsKey === '' ? [] : (targetsKey.split(',') as ChainKey[]));
    const set = (key: ChainKey, value: ChainBalances | undefined) =>
      setStore((s) => {
        if (s.address !== address) return s;
        const next = new Map(s.byChain);
        if (value === undefined) next.delete(key);
        else next.set(key, value);
        return { address, byChain: next };
      });

    // `running` keeps a chain's controller after its request finished, so a render that still holds
    // the old state never starts the same request twice; a retry or a new wallet clears it.
    // A chain that left the screen: stop its request and forget its state.
    for (const [key, controller] of running) {
      if (needed.has(key)) continue;
      controller.abort();
      running.delete(key);
      set(key, undefined);
    }
    for (const key of needed) {
      const known = store.byChain.get(key);
      if (running.has(key) || known !== undefined) continue;
      const chain = chains.find((c) => c.key === key);
      if (!chain) continue;
      if (!chain.balances) {
        set(key, { status: 'unavailable' });
        continue;
      }
      const controller = new AbortController();
      running.set(key, controller);
      set(key, { status: 'loading' });
      fetchBalances(key, address, controller.signal)
        .then((answer) => {
          if (controller.signal.aborted) return;
          set(key, { status: 'ready', byAddress: answer.byAddress });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || isAbort(err)) return;
          set(key, { status: 'error' });
        });
    }
  }, [address, chains, targetsKey, store]);

  return store.address === address ? store.byChain : EMPTY;
}

const EMPTY: ReadonlyMap<ChainKey, ChainBalances> = new Map();

'use client';

import { useEffect, useState } from 'react';
import { ApiError, apiConfigured, fetchChains, isAbort, type ApiErrorKind } from '@/lib/api/client';
import type { ApiChain } from '@/lib/api/schemas';

export type ChainsState =
  | { status: 'loading' }
  | { status: 'error'; kind: ApiErrorKind }
  | { status: 'ready'; chains: readonly ApiChain[] };

export function errorKind(err: unknown): ApiErrorKind {
  return err instanceof ApiError ? err.kind : 'network';
}

/**
 * The chains the API serves. One request per mount (and per retry), aborted when the component
 * leaves; an answer for an aborted request is dropped. Wallets, balances and the token list are
 * EVM only today, so only EVM chains are kept (ADR 0006, ADR 0009).
 */
export function useChains(): { chains: ChainsState; retry: () => void } {
  const [chains, setChains] = useState<ChainsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!apiConfigured()) {
      setChains({ status: 'error', kind: 'unconfigured' });
      return;
    }
    const controller = new AbortController();
    setChains({ status: 'loading' });
    fetchChains(controller.signal)
      .then((all) => {
        if (controller.signal.aborted) return;
        setChains({ status: 'ready', chains: all.filter((c) => c.family === 'evm') });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbort(err)) return;
        setChains({ status: 'error', kind: errorKind(err) });
      });
    return () => controller.abort();
  }, [attempt]);
  return { chains, retry: () => setAttempt((n) => n + 1) };
}

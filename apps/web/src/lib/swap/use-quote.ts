'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiConfigured, fetchQuote } from '@/lib/api/client';
import type { ApiQuote, QuoteAsk } from '@/lib/api/quote';
import { MAX_IDLE_REFRESHES, QUOTE_DEBOUNCE_MS } from './config';
import { expiryFromTiming, msLeft, realClock, type Clock, type Expiry } from './expiry';

/** Why there is no quote. Each maps to calm copy in the message file. */
export type QuoteErrorKind =
  | 'no_route'
  | 'routing_slow'
  | 'price_unavailable'
  | 'routing_unavailable'
  | 'signing_unavailable'
  | 'unavailable'
  | 'network'
  | 'offline'
  | 'timeout'
  | 'unconfigured'
  | 'clock';

export type QuoteState =
  /** Nothing to quote (no wallet, no amount, a pair that cannot be quoted). */
  | { status: 'idle' }
  /** Waiting for the pause in typing, for the answer, or for a replacement of an expired quote. */
  | { status: 'loading'; after: 'change' | 'expiry' }
  | { status: 'ready'; quote: ApiQuote; expiry: Expiry | null }
  /** The quote ran out and no replacement is being fetched: the tab was hidden or nobody is there. */
  | { status: 'expired' }
  | { status: 'error'; kind: QuoteErrorKind };

const IDLE: QuoteState = { status: 'idle' };
const LOADING: QuoteState = { status: 'loading', after: 'change' };

/** Maps a failed request to a kind. An error answer's code wins over its status. */
export function quoteErrorKind(err: unknown, online: boolean = true): QuoteErrorKind {
  if (!(err instanceof ApiError)) return 'unavailable';
  switch (err.kind) {
    case 'unconfigured':
      return 'unconfigured';
    case 'timeout':
      return 'timeout';
    case 'network':
      return online ? 'network' : 'offline';
    case 'http':
      switch (err.code) {
        case 'no_route':
        case 'routing_slow':
        case 'price_unavailable':
        case 'routing_unavailable':
        case 'signing_unavailable':
          return err.code;
        default:
          return 'unavailable';
      }
    default:
      return 'unavailable';
  }
}

/** Everything that makes one quote a different quote. */
export function quoteKey(ask: QuoteAsk): string {
  return [
    ask.sellToken.chain,
    ask.sellToken.address,
    ask.buyToken.chain,
    ask.buyToken.address,
    ask.sellAmount.toString(),
    ask.taker.toLowerCase(),
    ask.slippageBps,
  ].join('|');
}

export interface UseQuoteOptions {
  clock?: Clock;
  debounceMs?: number;
}

export interface UseQuote {
  state: QuoteState;
  /** Asks again now: the person pressed "get a new quote" or "try again". */
  refresh: () => void;
}

/**
 * The quote for `ask`, or `idle` when `ask` is `null`. One session per set of parameters:
 *
 * - A change of token, amount, wallet or slippage ends the session (aborting its request) and
 *   starts another after a pause in typing. The render for new parameters never shows the old
 *   parameters' state (`state.key === key`), not even for the one render before the effect runs.
 * - An answer that arrives after its session ended (the request was aborted, or the client
 *   resolved anyway) is dropped, so a quote never belongs to an amount or wallet the person left.
 *   This also covers A to B to A: the first A's late answer cannot land on the second A.
 * - When a quote runs out it is replaced at once, up to `MAX_IDLE_REFRESHES` times in a row, and
 *   only while the tab is visible (every quote can cost a paid upstream call). Returning to the
 *   tab, or `refresh`, starts the count over.
 * - Errors are not retried by themselves.
 */
export function useQuote(ask: QuoteAsk | null, options: UseQuoteOptions = {}): UseQuote {
  const clock = options.clock ?? realClock;
  const debounceMs = options.debounceMs ?? QUOTE_DEBOUNCE_MS;
  const key = ask === null ? null : quoteKey(ask);
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<{ key: string; state: QuoteState } | undefined>();
  /** Set by `refresh`: the next session starts at once instead of after the typing pause. */
  const immediate = useRef(false);

  useEffect(() => {
    if (ask === null || key === null) return;
    const request: QuoteAsk = ask;
    const session = new AbortController();
    let shown: QuoteState = LOADING;
    const set = (state: QuoteState) => {
      shown = state;
      setHeld({ key, state });
    };
    if (!apiConfigured()) {
      set({ status: 'error', kind: 'unconfigured' });
      return;
    }
    let inFlight: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiry: Expiry | null = null;
    let idleRefreshes = 0;

    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const fetchNow = (after: 'change' | 'expiry') => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      set({ status: 'loading', after });
      const sent = { mono: clock.mono(), wall: clock.wall() };
      fetchQuote(request, controller.signal).then(
        (quote) => {
          if (session.signal.aborted) return;
          if (quote.kind === 'wrap') {
            // Exact 1:1 with no signature: nothing runs out.
            expiry = null;
            set({ status: 'ready', quote, expiry: null });
            return;
          }
          const made = expiryFromTiming(quote, clock, sent, clock.mono());
          if (!made.ok) {
            if (made.reason === 'clock') {
              // The clocks disagree: asking again would not change that, so nothing loops.
              set({ status: 'error', kind: 'clock' });
            } else {
              // The answer took as long as the quote lives: never shown, replaced like an
              // expired one (and counted with them, so a slow API cannot loop either).
              expire();
            }
            return;
          }
          expiry = made.expiry;
          set({ status: 'ready', quote, expiry });
          arm();
        },
        (err: unknown) => {
          if (session.signal.aborted) return;
          const online = typeof navigator === 'undefined' || navigator.onLine;
          set({ status: 'error', kind: quoteErrorKind(err, online) });
        },
      );
    };

    /** Replaces an expired quote, or waits for the person when it should not run by itself. */
    const expire = () => {
      expiry = null;
      if (hidden() || idleRefreshes >= MAX_IDLE_REFRESHES) {
        set({ status: 'expired' });
        return;
      }
      idleRefreshes += 1;
      fetchNow('expiry');
    };

    const arm = () => {
      clearTimeout(timer);
      if (expiry === null) return;
      const current = expiry;
      timer = setTimeout(
        () => {
          if (session.signal.aborted) return;
          if (msLeft(current, clock) > 0) arm();
          else expire();
        },
        msLeft(current, clock),
      );
    };

    // A hidden tab's timers are throttled and a sleeping device's monotonic clock may pause: look
    // again when the tab comes back. A quote that ran out is replaced (and the idle count starts
    // over); one with time left is kept.
    const onVisible = () => {
      if (session.signal.aborted || hidden()) return;
      const ranOut = shown.status === 'expired' || (expiry !== null && msLeft(expiry, clock) === 0);
      if (!ranOut) return;
      idleRefreshes = 0;
      expire();
    };

    document.addEventListener('visibilitychange', onVisible);
    set(LOADING);
    const wait = immediate.current ? 0 : debounceMs;
    immediate.current = false;
    timer = setTimeout(() => fetchNow('change'), wait);
    return () => {
      session.abort();
      inFlight?.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, attempt]);

  const refresh = useCallback(() => {
    immediate.current = true;
    setAttempt((n) => n + 1);
  }, []);
  const state: QuoteState = key === null ? IDLE : held?.key === key ? held.state : LOADING;
  return { state, refresh };
}

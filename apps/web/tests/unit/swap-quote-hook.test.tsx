import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiClient from '../../src/lib/api/client';
import type { ApiQuote, QuoteAsk, SwapQuote, WrapQuote } from '../../src/lib/api/quote';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  MAX_IDLE_REFRESHES,
  QUOTE_DEBOUNCE_MS,
  QUOTE_LIFETIME_CAP_MS,
  SERVER_CLOCK_GRANULARITY_MS,
} from '../../src/lib/swap/config';
import type { Clock } from '../../src/lib/swap/expiry';
import { quoteErrorKind, quoteKey, useQuote } from '../../src/lib/swap/use-quote';
import { ASK, TAKER } from './helpers/quote-fixtures';
import { renderHook } from './helpers/render-hook';

/**
 * `useQuote`, run for real with a stand-in client whose answers the test releases by hand and
 * which ignores the abort signal: an answer arrives even after the hook gave up on its request,
 * which is what the guards in use-quote.ts exist for. Time is a fake clock plus fake timers.
 * The end-to-end versions are in tests/e2e/swap-quote.spec.ts.
 */

interface Pending {
  ask: QuoteAsk;
  signal: AbortSignal;
  resolve: (value: ApiQuote) => void;
  reject: (error: unknown) => void;
}
const pending = vi.hoisted(() => ({ list: [] as Pending[] }));

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    apiConfigured: () => true,
    fetchQuote: (ask: QuoteAsk, signal: AbortSignal) =>
      new Promise<ApiQuote>((resolve, reject) => {
        pending.list.push({ ask, signal, resolve, reject });
      }),
  };
});

/** The fake device: wall and monotonic clocks the test moves together (or apart). */
function makeClock() {
  let wall = 1_790_000_000_000;
  let mono = 10_000;
  const clock: Clock = { wall: () => wall, mono: () => mono };
  return {
    clock,
    pass(ms: number) {
      wall += ms;
      mono += ms;
    },
    /** The device sleeps: the wall clock moves, the monotonic clock does not. */
    passWallOnly(ms: number) {
      wall += ms;
    },
    get wall() {
      return wall;
    },
  };
}

/** `document` as far as the hook uses it: visibility and its change event. */
function makeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  return {
    doc,
    set(state: 'visible' | 'hidden') {
      doc.visibilityState = state;
      for (const fn of [...listeners]) fn();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

const clockState = { c: makeClock(), d: makeDocument() };
const swap = (buy: bigint, serverTimeSec: number, ttlSeconds: number): SwapQuote => ({
  kind: 'swap',
  buyAmount: buy,
  minBuyAmount: buy - 1n,
  buyUsdCents: 100n,
  networkCostUsdCents: 31n,
  provider: '0x',
  routeCount: 2,
  fee: { bps: 20, reason: 'tier-under-10k', amount: 1n, waivedUsdCents: 0n },
  deadlineSec: BigInt(serverTimeSec + ttlSeconds),
  serverTimeSec,
  ttlSeconds,
});
const wrap = (): WrapQuote => ({
  kind: 'wrap',
  direction: 'wrap',
  buyAmount: 5n,
  minBuyAmount: 5n,
  fee: { bps: 0, reason: 'wrap-unwrap', amount: 0n, waivedUsdCents: 0n },
});
/**
 * A quote the API signed for `ttlSeconds`, as read at the fake device's now. `serverAheadSec` is
 * how far the API's clock is ahead of the device's (negative: behind).
 */
const fresh = (buy: bigint, ttlSeconds = 60, serverAheadSec = 0) =>
  swap(buy, Math.floor(clockState.c.wall / 1000) + serverAheadSec, ttlSeconds);

const ask = (amount: bigint, taker = TAKER): QuoteAsk => ({ ...ASK, sellAmount: amount, taker });
type Props = { ask: QuoteAsk | null };
const hook = (p: Props) => useQuote(p.ask, { clock: clockState.c.clock });

/** Moves the fake device and the timers together. */
async function advance(ms: number) {
  clockState.c.pass(ms);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const start = (a: QuoteAsk | null) => renderHook<Props, ReturnType<typeof hook>>(hook, { ask: a });
/** The tab is hidden or shown (inside `act`, as React needs for the state it sets). */
const show = (state: 'visible' | 'hidden') => act(async () => clockState.d.set(state));
/** Waits out the typing pause. */
const pause = () => advance(QUOTE_DEBOUNCE_MS);

beforeEach(() => {
  pending.list.length = 0;
  clockState.c = makeClock();
  clockState.d = makeDocument();
  vi.stubGlobal('document', clockState.d.doc);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useQuote: when it asks', () => {
  it('asks nothing for no parameters, and shows idle', async () => {
    const run = await start(null);
    await pause();
    expect(pending.list).toHaveLength(0);
    expect(run.latest.state).toEqual({ status: 'idle' });
    await run.unmount();
  });

  it('waits for a pause in typing: three changes in a row make one request, for the last', async () => {
    const run = await start(ask(1n));
    await advance(100);
    await run.rerender({ ask: ask(2n) });
    await advance(100);
    await run.rerender({ ask: ask(3n) });
    expect(run.latest.state).toEqual({ status: 'loading', after: 'change' });
    await advance(QUOTE_DEBOUNCE_MS - 1);
    expect(pending.list).toHaveLength(0);
    await advance(1);
    expect(pending.list.map((p) => p.ask.sellAmount)).toEqual([3n]);
    await run.unmount();
  });

  it('the same parameters in another letter case are the same quote', async () => {
    const run = await start(ask(1n, TAKER));
    await pause();
    await run.rerender({ ask: ask(1n, TAKER.toLowerCase()) });
    await pause();
    expect(pending.list).toHaveLength(1);
    expect(quoteKey(ask(1n, TAKER))).toBe(
      quoteKey(ask(1n, TAKER.toUpperCase().replace('0X', '0x'))),
    );
    await run.unmount();
  });

  it('aborts the request of parameters that were left', async () => {
    const run = await start(ask(1n));
    await pause();
    expect(pending.list[0]!.signal.aborted).toBe(false);
    await run.rerender({ ask: ask(2n) });
    expect(pending.list[0]!.signal.aborted).toBe(true);
    await run.unmount();
  });

  it('aborts when the parameters go away (the wallet disconnected, the amount was cleared)', async () => {
    const run = await start(ask(1n));
    await pause();
    await run.rerender({ ask: null });
    expect(pending.list[0]!.signal.aborted).toBe(true);
    pending.list[0]!.resolve(fresh(9n));
    await run.rerender({ ask: null });
    expect(run.latest.state).toEqual({ status: 'idle' });
    await run.unmount();
  });

  it('aborts on unmount, and an answer after unmount renders nothing', async () => {
    const run = await start(ask(1n));
    await pause();
    await run.unmount();
    const rendered = run.renders.length;
    expect(pending.list[0]!.signal.aborted).toBe(true);
    pending.list[0]!.resolve(fresh(9n));
    await advance(10);
    expect(run.renders).toHaveLength(rendered);
  });
});

describe('useQuote: answers that are no longer wanted are dropped', () => {
  it('a late answer for the previous amount never replaces the newer quote', async () => {
    const run = await start(ask(1n));
    await pause();
    await run.rerender({ ask: ask(2n) });
    await pause();
    expect(pending.list).toHaveLength(2);
    pending.list[1]!.resolve(fresh(222n));
    await vi.waitFor(() => expect(run.latest.state.status).toBe('ready'));
    pending.list[0]!.resolve(fresh(111n));
    await run.rerender({ ask: ask(2n) });
    expect(run.latest.state).toMatchObject({ status: 'ready', quote: { buyAmount: 222n } });
    await run.unmount();
  });

  it('a late answer of an older request cannot land on a later request for the same parameters (A, B, A)', async () => {
    const run = await start(ask(1n));
    await pause();
    await run.rerender({ ask: ask(2n) });
    await pause();
    await run.rerender({ ask: ask(1n) });
    await pause();
    expect(pending.list.map((p) => p.ask.sellAmount)).toEqual([1n, 2n, 1n]);
    pending.list[0]!.resolve(fresh(111n)); // the first A answers late
    await run.rerender({ ask: ask(1n) });
    expect(run.latest.state).toEqual({ status: 'loading', after: 'change' });
    pending.list[2]!.resolve(fresh(333n));
    await vi.waitFor(() =>
      expect(run.latest.state).toMatchObject({ status: 'ready', quote: { buyAmount: 333n } }),
    );
    await run.unmount();
  });

  it('a late failure of an older request is not shown as an error', async () => {
    const run = await start(ask(1n));
    await pause();
    await run.rerender({ ask: ask(2n) });
    await pause();
    pending.list[1]!.resolve(fresh(222n));
    await vi.waitFor(() => expect(run.latest.state.status).toBe('ready'));
    pending.list[0]!.reject(new Error('socket closed'));
    await run.rerender({ ask: ask(2n) });
    expect(run.latest.state.status).toBe('ready');
    await run.unmount();
  });

  it('every render for new parameters is loading: the old quote is never returned, not even before the effect runs', async () => {
    const run = await start(ask(1n));
    await pause();
    pending.list[0]!.resolve(fresh(111n));
    await vi.waitFor(() => expect(run.latest.state.status).toBe('ready'));
    await run.rerender({ ask: ask(2n) });
    const forNew = run.renders.filter((r) => r.props.ask?.sellAmount === 2n);
    expect(forNew.length).toBeGreaterThan(0);
    for (const r of forNew) expect(r.result.state.status).not.toBe('ready');
    await run.unmount();
  });

  it('a wallet switched mid-quote: the old wallet answer is dropped and the new wallet is asked', async () => {
    const other = '0x1111111111111111111111111111111111112222';
    const run = await start(ask(1n, TAKER));
    await pause();
    await run.rerender({ ask: ask(1n, other) });
    // Every render for the new wallet shows no quote of the old one.
    for (const r of run.renders.filter((x) => x.props.ask?.taker === other)) {
      expect(r.result.state.status).toBe('loading');
    }
    await pause();
    expect(pending.list.map((p) => p.ask.taker)).toEqual([TAKER, other]);
    expect(pending.list[0]!.signal.aborted).toBe(true);
    pending.list[0]!.resolve(fresh(111n));
    await run.rerender({ ask: ask(1n, other) });
    expect(run.latest.state.status).toBe('loading');
    await run.unmount();
  });
});

describe('useQuote: errors', () => {
  it('a failed request is an error, and nothing asks again by itself', async () => {
    const run = await start(ask(1n));
    await pause();
    const { ApiError } = await import('../../src/lib/api/client');
    pending.list[0]!.reject(new ApiError('http', 502, 'no_route'));
    await vi.waitFor(() => expect(run.latest.state).toEqual({ status: 'error', kind: 'no_route' }));
    await advance(10 * 60_000);
    expect(pending.list).toHaveLength(1);
    await run.unmount();
  });

  it('"try again" asks at once, without the typing pause, and an older answer is still dropped', async () => {
    const run = await start(ask(1n));
    await pause();
    const { ApiError } = await import('../../src/lib/api/client');
    pending.list[0]!.reject(new ApiError('network'));
    await vi.waitFor(() => expect(run.latest.state.status).toBe('error'));
    act(() => run.latest.refresh());
    // No time passes: the request is already out, not after the typing pause.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pending.list).toHaveLength(2);
    expect(run.latest.state).toEqual({ status: 'loading', after: 'change' });
    pending.list[0]!.resolve(fresh(111n)); // the failed request answers after all
    await run.rerender({ ask: ask(1n) });
    expect(run.latest.state.status).toBe('loading');
    pending.list[1]!.resolve(fresh(222n));
    await vi.waitFor(() => expect(run.latest.state.status).toBe('ready'));
    await run.unmount();
  });

  it.each([
    ['an hour ahead', 3_600],
    ['an hour behind', -3_600],
    ['just beyond the tolerance, ahead', CLOCK_SKEW_TOLERANCE_MS / 1000 + 2],
    ['just beyond the tolerance, behind', -(CLOCK_SKEW_TOLERANCE_MS / 1000 + 2)],
  ])(
    'a device clock that is %s of the server is a clock error, and is not asked for again',
    async (_n, ahead) => {
      // `ahead` is how far the API's clock is ahead of the device's.
      const run = await start(ask(1n));
      await pause();
      pending.list[0]!.resolve(fresh(5n, 60, ahead));
      await vi.waitFor(() => expect(run.latest.state).toEqual({ status: 'error', kind: 'clock' }));
      await advance(10 * 60_000);
      expect(pending.list).toHaveLength(1);
      await run.unmount();
    },
  );

  it('a device clock inside the tolerance is not an error and does not change the countdown', async () => {
    for (const ahead of [-20, 20]) {
      pending.list.length = 0;
      const run = await start(ask(1n));
      await pause();
      pending.list[0]!.resolve(fresh(5n, 30, ahead));
      await vi.waitFor(() => expect(run.latest.state.status).toBe('ready'));
      await advance(30_000 - SERVER_CLOCK_GRANULARITY_MS - 1);
      expect(pending.list).toHaveLength(1);
      await advance(1);
      expect(pending.list).toHaveLength(2);
      await run.unmount();
    }
  });

  it.each([
    [{ kind: 'unconfigured' }, 'unconfigured'],
    [{ kind: 'timeout' }, 'timeout'],
    [{ kind: 'network' }, 'network'],
    [{ kind: 'http', status: 502, code: 'no_route' }, 'no_route'],
    [{ kind: 'http', status: 502, code: 'routing_slow' }, 'routing_slow'],
    [{ kind: 'http', status: 503, code: 'price_unavailable' }, 'price_unavailable'],
    [{ kind: 'http', status: 503, code: 'routing_unavailable' }, 'routing_unavailable'],
    [{ kind: 'http', status: 503, code: 'signing_unavailable' }, 'signing_unavailable'],
    [{ kind: 'http', status: 500, code: 'internal_error' }, 'unavailable'],
    [{ kind: 'http', status: 400, code: 'invalid_request' }, 'unavailable'],
    [{ kind: 'http', status: 502 }, 'unavailable'],
    [{ kind: 'http', status: 429 }, 'unavailable'],
    [{ kind: 'content' }, 'unavailable'],
    [{ kind: 'invalid' }, 'unavailable'],
  ] as const)('maps %j to %s', async (e, kind) => {
    const { ApiError } = await import('../../src/lib/api/client');
    const err = new ApiError(
      e.kind,
      'status' in e ? e.status : undefined,
      'code' in e ? e.code : undefined,
    );
    expect(quoteErrorKind(err)).toBe(kind);
  });

  it('offline is told apart from an unreachable server, and an unknown error is "unavailable"', async () => {
    const { ApiError } = await import('../../src/lib/api/client');
    expect(quoteErrorKind(new ApiError('network'), false)).toBe('offline');
    expect(quoteErrorKind(new Error('boom'))).toBe('unavailable');
    expect(quoteErrorKind('boom')).toBe('unavailable');
  });
});

describe('useQuote: expiry', () => {
  async function ready(run: Awaited<ReturnType<typeof start>>, i: number, buy: bigint, life = 60) {
    await vi.waitFor(() => expect(pending.list.length).toBeGreaterThan(i));
    pending.list[i]!.resolve(fresh(buy, life));
    await vi.waitFor(() => expect(run.latest.state.status).toBe('ready'));
  }

  it('a quote that runs out is replaced at once, and the screen says so while it waits', async () => {
    const run = await start(ask(1n));
    await pause();
    await ready(run, 0, 111n);
    // A 60 s lifetime counts from the send, less the second the API's clock may have lost.
    await advance(60_000 - SERVER_CLOCK_GRANULARITY_MS - 1);
    expect(run.latest.state.status).toBe('ready');
    expect(pending.list).toHaveLength(1);
    await advance(1);
    expect(pending.list).toHaveLength(2);
    expect(run.latest.state).toEqual({ status: 'loading', after: 'expiry' });
    await ready(run, 1, 222n);
    expect(run.latest.state).toMatchObject({ quote: { buyAmount: 222n } });
    await run.unmount();
  });

  it.each([10, 30, 60, 600])(
    "the answer's lifetime of %i s is followed, up to the cap, counted from the send",
    async (ttl) => {
      const lifetime = Math.min(ttl * 1000 - SERVER_CLOCK_GRANULARITY_MS, QUOTE_LIFETIME_CAP_MS);
      const run = await start(ask(1n));
      await pause();
      await advance(0);
      await ready(run, 0, 111n, ttl);
      await advance(lifetime - 1);
      expect(pending.list).toHaveLength(1);
      expect(run.latest.state.status).toBe('ready');
      await advance(1);
      expect(pending.list).toHaveLength(2);
      expect(run.latest.state).toEqual({ status: 'loading', after: 'expiry' });
      await run.unmount();
    },
  );

  it('an API lifetime of 600 s never keeps a quote longer than the cap', async () => {
    const run = await start(ask(1n));
    await pause();
    await ready(run, 0, 111n, 600);
    await advance(QUOTE_LIFETIME_CAP_MS);
    expect(pending.list).toHaveLength(2);
    await run.unmount();
  });

  it('the lifetime counts from the send: a slow answer has that much less', async () => {
    const run = await start(ask(1n));
    await pause();
    await advance(5_000); // the request has been out for five seconds
    pending.list[0]!.resolve(fresh(111n, 30));
    await vi.waitFor(() => expect(run.latest.state.status).toBe('ready'));
    await advance(30_000 - SERVER_CLOCK_GRANULARITY_MS - 5_000 - 1);
    expect(pending.list).toHaveLength(1);
    await advance(1);
    expect(pending.list).toHaveLength(2);
    await run.unmount();
  });

  it('an answer that took the whole lifetime is never shown: it is replaced, and a slow API cannot loop', async () => {
    const run = await start(ask(1n));
    await pause();
    const life = 10_000 - SERVER_CLOCK_GRANULARITY_MS;
    for (let n = 0; n <= MAX_IDLE_REFRESHES; n++) {
      await vi.waitFor(() => expect(pending.list.length).toBeGreaterThan(n));
      await advance(life);
      pending.list[n]!.resolve(fresh(100n + BigInt(n), 10));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Not one render shows a ready quote.
      expect(run.renders.some((r) => r.result.state.status === 'ready')).toBe(false);
    }
    expect(run.latest.state).toEqual({ status: 'expired' });
    expect(pending.list).toHaveLength(MAX_IDLE_REFRESHES + 1);
    await advance(10 * 60_000);
    expect(pending.list).toHaveLength(MAX_IDLE_REFRESHES + 1);
    await run.unmount();
  });

  it(`replaces an expired quote by itself ${MAX_IDLE_REFRESHES} times, then waits for the person`, async () => {
    const run = await start(ask(1n));
    await pause();
    await ready(run, 0, 100n);
    for (let n = 1; n <= MAX_IDLE_REFRESHES; n++) {
      await advance(60_000);
      expect(pending.list).toHaveLength(n + 1);
      await ready(run, n, 100n + BigInt(n));
    }
    await advance(60_000);
    expect(pending.list).toHaveLength(MAX_IDLE_REFRESHES + 1);
    expect(run.latest.state).toEqual({ status: 'expired' });
    await advance(10 * 60_000);
    expect(pending.list).toHaveLength(MAX_IDLE_REFRESHES + 1);

    // The person asks: a new quote at once, and the count starts over.
    act(() => run.latest.refresh());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pending.list).toHaveLength(MAX_IDLE_REFRESHES + 2);
    await ready(run, MAX_IDLE_REFRESHES + 1, 999n);
    await advance(60_000);
    expect(pending.list).toHaveLength(MAX_IDLE_REFRESHES + 3);
    await run.unmount();
  });

  it('changing the amount starts the count over', async () => {
    const run = await start(ask(1n));
    await pause();
    await ready(run, 0, 100n);
    for (let n = 1; n <= MAX_IDLE_REFRESHES; n++) {
      await advance(60_000);
      await ready(run, n, 100n);
    }
    await run.rerender({ ask: ask(2n) });
    await pause();
    await ready(run, MAX_IDLE_REFRESHES + 1, 200n);
    await advance(60_000);
    expect(run.latest.state).toEqual({ status: 'loading', after: 'expiry' });
    await run.unmount();
  });

  it('a hidden tab does not buy quotes: it waits, and replaces the quote when it is shown again', async () => {
    const run = await start(ask(1n));
    await pause();
    await ready(run, 0, 100n);
    await show('hidden');
    await advance(60_000);
    expect(pending.list).toHaveLength(1);
    expect(run.latest.state).toEqual({ status: 'expired' });
    await show('visible');
    await vi.waitFor(() => expect(pending.list).toHaveLength(2));
    expect(run.latest.state).toEqual({ status: 'loading', after: 'expiry' });
    await run.unmount();
  });

  it('coming back to a tab whose quote still has time left keeps the quote and asks nothing', async () => {
    const run = await start(ask(1n));
    await pause();
    await ready(run, 0, 100n);
    await show('hidden');
    await advance(20_000);
    await show('visible');
    await advance(0);
    expect(pending.list).toHaveLength(1);
    expect(run.latest.state.status).toBe('ready');
    await run.unmount();
  });

  it('a device that slept through the quote replaces it on waking, though no timer fired', async () => {
    const run = await start(ask(1n));
    await pause();
    await ready(run, 0, 100n);
    await show('hidden');
    // Ten minutes asleep: the wall clock moved, the monotonic clock and the timers did not.
    clockState.c.passWallOnly(10 * 60_000);
    expect(pending.list).toHaveLength(1);
    await show('visible');
    await vi.waitFor(() => expect(pending.list).toHaveLength(2));
    expect(run.latest.state).toEqual({ status: 'loading', after: 'expiry' });
    await run.unmount();
  });

  it('a wrap has no expiry and is never replaced', async () => {
    const run = await start(ask(1n));
    await pause();
    pending.list[0]!.resolve(wrap());
    await vi.waitFor(() =>
      expect(run.latest.state).toEqual({ status: 'ready', quote: wrap(), expiry: null }),
    );
    await advance(60 * 60_000);
    expect(pending.list).toHaveLength(1);
    await run.unmount();
  });

  it('removes its listener when it goes away', async () => {
    const run = await start(ask(1n));
    await pause();
    expect(clockState.d.listeners).toBe(1);
    await run.unmount();
    expect(clockState.d.listeners).toBe(0);
  });
});

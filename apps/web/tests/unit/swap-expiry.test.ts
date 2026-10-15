import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  QUOTE_LIFETIME_CAP_MS,
  SERVER_CLOCK_GRANULARITY_MS,
} from '../../src/lib/swap/config';
import {
  clockDisagrees,
  expiryFromTiming,
  msLeft,
  secondsLeft,
  type Clock,
  type Expiry,
} from '../../src/lib/swap/expiry';

/** A clock the test moves by hand. `skew` is how far the device's wall clock is from the API's. */
function fakeClock(startWall = 1_790_000_000_000) {
  let wall = startWall;
  let mono = 5_000;
  const clock: Clock = { wall: () => wall, mono: () => mono };
  return {
    clock,
    /** Time passes: both clocks move. */
    pass(ms: number) {
      wall += ms;
      mono += ms;
    },
    /** The device sleeps: the wall clock moves, the monotonic clock does not. */
    sleep(ms: number) {
      wall += ms;
    },
    /** The person (or NTP) sets the wall clock. */
    setWall(to: number) {
      wall = to;
    },
    get wall() {
      return wall;
    },
    get mono() {
      return mono;
    },
  };
}

const made = (r: ReturnType<typeof expiryFromTiming>): Expiry => {
  if (!r.ok) throw new Error(`no expiry: ${r.reason}`);
  return r.expiry;
};

/**
 * One request as the device sees it. The API reads its clock `serverAfterMs` after the request was
 * sent and the answer arrives `arriveAfterMs` after it was sent. `deviceAheadMs` is how far the
 * device's wall clock is ahead of the API's (negative: behind). The API writes `serverTime` in
 * whole seconds (floored), so the same instant may be up to 999 ms later than `serverTime`.
 */
function request(
  c: ReturnType<typeof fakeClock>,
  ttlSeconds: number,
  opts: { serverAfterMs?: number; arriveAfterMs?: number; deviceAheadMs?: number } = {},
) {
  const { serverAfterMs = 100, arriveAfterMs = 300, deviceAheadMs = 0 } = opts;
  const sent = { mono: c.mono, wall: c.wall };
  const serverNowMs = c.wall + serverAfterMs - deviceAheadMs; // the API's clock at its reading
  const serverTimeSec = Math.floor(serverNowMs / 1000);
  c.pass(arriveAfterMs);
  const timing = { serverTimeSec, ttlSeconds };
  return { sent, timing, result: expiryFromTiming(timing, c.clock, sent, c.mono) };
}

/** What the server's lifetime is worth on the device: its seconds, less the second it may have lost. */
const lifetime = (ttlSeconds: number) => ttlSeconds * 1000 - SERVER_CLOCK_GRANULARITY_MS;

describe('expiryFromTiming: min(ttlSeconds, cap) counted from the moment the request was sent', () => {
  it.each([
    [10, lifetime(10)],
    [30, lifetime(30)],
    [60, lifetime(60)],
    [61, QUOTE_LIFETIME_CAP_MS],
    [600, QUOTE_LIFETIME_CAP_MS],
  ])(
    'ttl %i s: the quote lives %i ms from the send, minus the 300 ms the answer took',
    (ttl, life) => {
      const c = fakeClock();
      const r = request(c, ttl);
      const e = made(r.result);
      expect(msLeft(e, c.clock)).toBe(life - 300);
      c.pass(life - 300 - 1);
      expect(msLeft(e, c.clock)).toBe(1);
      c.pass(1);
      expect(msLeft(e, c.clock)).toBe(0);
      expect(secondsLeft(e, c.clock)).toBe(0);
    },
  );

  it('counts down in whole seconds, rounded up', () => {
    const c = fakeClock();
    const e = made(request(c, 30).result);
    expect(secondsLeft(e, c.clock)).toBe(29);
    c.pass(10_000);
    expect(secondsLeft(e, c.clock)).toBe(19);
  });

  it('a server lifetime of 600 s is capped at the old-style 60 s from the send', () => {
    const c = fakeClock();
    const e = made(request(c, 600, { arriveAfterMs: 400 }).result);
    expect(msLeft(e, c.clock)).toBe(QUOTE_LIFETIME_CAP_MS - 400);
  });

  it('the old-style 60 s cap still applies to any lifetime above it, and to nothing below it', () => {
    const c = fakeClock();
    const r = request(c, 61);
    expect(msLeft(made(r.result), c.clock)).toBe(QUOTE_LIFETIME_CAP_MS - 300);
    const c2 = fakeClock();
    const sent = { mono: c2.mono, wall: c2.wall };
    const timing = { serverTimeSec: Math.floor(c2.wall / 1000), ttlSeconds: 600 };
    // A cap passed in (the config value is the default) bounds a longer lifetime...
    const capped = made(expiryFromTiming(timing, c2.clock, sent, c2.mono, 20_000));
    expect(msLeft(capped, c2.clock)).toBe(20_000);
    // ...and a shorter lifetime is not stretched to it.
    const short = made(
      expiryFromTiming({ ...timing, ttlSeconds: 10 }, c2.clock, sent, c2.mono, 20_000),
    );
    expect(msLeft(short, c2.clock)).toBe(lifetime(10));
  });

  it('never runs past the signed deadline, whichever fraction of the second the server read', () => {
    // deadline = serverTime + ttl, in the API's whole seconds. The quote must end no later than the
    // deadline on the API's clock, even when the API read its clock at the very start of a second.
    for (const fraction of [0, 1, 500, 999]) {
      const c = fakeClock(1_790_000_000_000 + fraction);
      const ttl = 30;
      const r = request(c, ttl, { serverAfterMs: 0, arriveAfterMs: 0 });
      const e = made(r.result);
      const deadlineWallMs = (r.timing.serverTimeSec + ttl) * 1000;
      // The device and the API share a clock here, so the end of the countdown (in wall time)
      // must not be after the deadline.
      const endsWall = c.wall + msLeft(e, c.clock);
      expect(endsWall).toBeLessThanOrEqual(deadlineWallMs);
    }
  });

  it('a slow answer eats the lifetime: it counts from the send, not from the arrival', () => {
    const c = fakeClock();
    const e = made(request(c, 30, { serverAfterMs: 100, arriveAfterMs: 5_000 }).result);
    expect(msLeft(e, c.clock)).toBe(lifetime(30) - 5_000);
  });

  it('an answer that took the whole lifetime is late, never shown as valid', () => {
    const c = fakeClock();
    const r = request(c, 10, { serverAfterMs: 100, arriveAfterMs: lifetime(10) });
    expect(r.result).toEqual({ ok: false, reason: 'late' });
    const c2 = fakeClock();
    expect(request(c2, 10, { arriveAfterMs: lifetime(10) + 5_000 }).result).toEqual({
      ok: false,
      reason: 'late',
    });
    // One millisecond left is still a quote.
    const c3 = fakeClock();
    expect(request(c3, 10, { arriveAfterMs: lifetime(10) - 1 }).result.ok).toBe(true);
  });
});

describe('expiryFromTiming: a device clock that disagrees with the server', () => {
  it.each([0, 5_000, -5_000, 29_000, -29_000])(
    'a device clock %i ms off is within tolerance, and the countdown does not move',
    (deviceAheadMs) => {
      const c = fakeClock();
      const r = request(c, 30, { deviceAheadMs });
      expect(msLeft(made(r.result), c.clock)).toBe(lifetime(30) - 300);
    },
  );

  it('a device clock well AHEAD of the server is reported, not retried', () => {
    const c = fakeClock();
    expect(request(c, 60, { deviceAheadMs: 3_600_000 }).result).toEqual({
      ok: false,
      reason: 'clock',
    });
    const c2 = fakeClock();
    expect(request(c2, 60, { deviceAheadMs: CLOCK_SKEW_TOLERANCE_MS + 2_000 }).result).toEqual({
      ok: false,
      reason: 'clock',
    });
  });

  it('a device clock well BEHIND the server is reported too', () => {
    const c = fakeClock();
    expect(request(c, 60, { deviceAheadMs: -3_600_000 }).result).toEqual({
      ok: false,
      reason: 'clock',
    });
    const c2 = fakeClock();
    expect(request(c2, 60, { deviceAheadMs: -(CLOCK_SKEW_TOLERANCE_MS + 2_000) }).result).toEqual({
      ok: false,
      reason: 'clock',
    });
  });

  it('a clock that is skewed does not change how long a quote lives when it is within tolerance', () => {
    // Behind or ahead by 20 s: the countdown is the lifetime from the send either way, never the
    // deadline minus the device's "now".
    for (const deviceAheadMs of [20_000, -20_000]) {
      const c = fakeClock();
      expect(msLeft(made(request(c, 600, { deviceAheadMs }).result), c.clock)).toBe(
        QUOTE_LIFETIME_CAP_MS - 300,
      );
    }
  });

  it('a slow answer is not mistaken for skew: the server may have read its clock at any instant', () => {
    // Device in step, the answer took 40 s, the server read its clock right at the start: the
    // arrival is 40 s after serverTime on the device clock, but that is the trip, not skew.
    const c = fakeClock();
    expect(request(c, 600, { serverAfterMs: 0, arriveAfterMs: 40_000 }).result.ok).toBe(true);
    // The same slow answer does not hide a device clock that is far ahead (the smallest possible
    // skew is still above the tolerance)...
    const c2 = fakeClock();
    expect(
      request(c2, 600, { serverAfterMs: 0, arriveAfterMs: 40_000, deviceAheadMs: 90_000 }).result,
    ).toEqual({ ok: false, reason: 'clock' });
    // ...nor one that is far behind (the largest possible skew is still below minus it).
    const c3 = fakeClock();
    expect(
      request(c3, 600, { serverAfterMs: 40_000, arriveAfterMs: 40_000, deviceAheadMs: -100_000 })
        .result,
    ).toEqual({ ok: false, reason: 'clock' });
    // A device 10 s behind with a 40 s answer is inside the tolerance.
    const c4 = fakeClock();
    expect(
      request(c4, 600, { serverAfterMs: 40_000, arriveAfterMs: 40_000, deviceAheadMs: -10_000 })
        .result.ok,
    ).toBe(true);
  });

  describe('clockDisagrees', () => {
    const T = CLOCK_SKEW_TOLERANCE_MS;
    it('is false for a clock in step and true only beyond the tolerance, both ways', () => {
      const sent = 1_790_000_000_000;
      const serverSec = 1_790_000_000;
      expect(clockDisagrees(serverSec, sent, sent + 300)).toBe(false);
      // Ahead: even the smallest possible skew is above the tolerance.
      expect(clockDisagrees(serverSec, sent + T + 999, sent + T + 999)).toBe(false);
      expect(clockDisagrees(serverSec, sent + T + 1_000, sent + T + 1_000)).toBe(true);
      // Behind: even the largest possible skew is below minus the tolerance.
      expect(clockDisagrees(serverSec, sent - T - 1, sent - T)).toBe(false);
      expect(clockDisagrees(serverSec, sent - T - 2, sent - T - 1)).toBe(true);
    });
    it('uses the tolerance it is given', () => {
      expect(clockDisagrees(1_000, 1_000_000 + 5_001, 1_000_000 + 5_001, 5_000)).toBe(false);
      expect(clockDisagrees(1_000, 1_000_000 + 6_000, 1_000_000 + 6_000, 5_000)).toBe(true);
    });
  });
});

describe('the countdown runs on the monotonic clock', () => {
  const start = () => {
    const c = fakeClock();
    const e = made(request(c, 61, { serverAfterMs: 0, arriveAfterMs: 0 }).result);
    return { c, e };
  };

  it('setting the wall clock BACKWARD does not extend the quote', () => {
    const { c, e } = start();
    c.pass(40_000);
    c.setWall(c.wall - 3_600_000);
    expect(msLeft(e, c.clock)).toBe(20_000);
    c.pass(20_000);
    expect(msLeft(e, c.clock)).toBe(0);
  });

  it('setting the wall clock FORWARD past the lifetime expires it (early is the safe direction)', () => {
    const { c, e } = start();
    c.pass(1_000);
    c.setWall(c.wall + 3_600_000);
    expect(msLeft(e, c.clock)).toBe(0);
  });

  it('a small forward wall clock correction only shortens it, by that much', () => {
    const { c, e } = start();
    c.pass(10_000);
    c.setWall(c.wall + 1_500);
    expect(msLeft(e, c.clock)).toBe(48_500);
  });

  it('a device that slept (monotonic clock paused, wall clock moved) is expired on waking', () => {
    const { c, e } = start();
    c.pass(10_000);
    c.sleep(10 * 60_000);
    expect(msLeft(e, c.clock)).toBe(0);
    expect(secondsLeft(e, c.clock)).toBe(0);
  });

  it('a short nap counts: the wall clock sees the time the monotonic clock missed', () => {
    const { c, e } = start();
    c.pass(10_000);
    c.sleep(30_000);
    expect(msLeft(e, c.clock)).toBe(20_000);
  });
});

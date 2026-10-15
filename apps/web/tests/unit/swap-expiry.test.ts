import { describe, expect, it } from 'vitest';
import { QUOTE_LIFETIME_CAP_MS } from '../../src/lib/swap/config';
import {
  expiryFromDeadline,
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

const made = (r: ReturnType<typeof expiryFromDeadline>): Expiry => {
  if (!r.ok) throw new Error(`no expiry: ${r.reason}`);
  return r.expiry;
};

describe('expiryFromDeadline', () => {
  it('a device clock in step: the quote has what the server gave it', () => {
    const c = fakeClock();
    // The API signs 60 s from its "now" (= the device's wall clock here); the answer takes 300 ms.
    const deadlineSec = (c.wall + 60_000) / 1000;
    const sent = c.mono;
    c.pass(300);
    const e = made(expiryFromDeadline(deadlineSec, c.clock, sent, c.mono));
    expect(msLeft(e, c.clock)).toBe(59_700);
    expect(secondsLeft(e, c.clock)).toBe(60);
    c.pass(30_000);
    expect(secondsLeft(e, c.clock)).toBe(30);
    c.pass(29_699);
    expect(msLeft(e, c.clock)).toBe(1);
    expect(secondsLeft(e, c.clock)).toBe(1);
    c.pass(1);
    expect(msLeft(e, c.clock)).toBe(0);
    expect(secondsLeft(e, c.clock)).toBe(0);
  });

  it('a device clock that runs BEHIND never shows more than the cap, counted from the request', () => {
    const c = fakeClock();
    // The device thinks it is an hour earlier than the server: the deadline looks 61 minutes away.
    const deadlineSec = (c.wall + 3_600_000 + 60_000) / 1000;
    const sent = c.mono;
    c.pass(400);
    const e = made(expiryFromDeadline(deadlineSec, c.clock, sent, c.mono));
    expect(msLeft(e, c.clock)).toBe(QUOTE_LIFETIME_CAP_MS - 400);
    c.pass(QUOTE_LIFETIME_CAP_MS - 400);
    expect(msLeft(e, c.clock)).toBe(0);
  });

  it('a device clock that runs AHEAD by part of the lifetime shortens the quote, never lengthens it', () => {
    const c = fakeClock();
    // 20 s ahead: the deadline looks 40 s away instead of 60 s.
    const deadlineSec = (c.wall - 20_000 + 60_000) / 1000;
    const sent = c.mono;
    const e = made(expiryFromDeadline(deadlineSec, c.clock, sent, c.mono));
    expect(msLeft(e, c.clock)).toBe(40_000);
  });

  it('a device clock ahead by more than the whole lifetime is reported, not retried', () => {
    const c = fakeClock();
    const deadlineSec = (c.wall - 5_000) / 1000;
    const r = expiryFromDeadline(deadlineSec, c.clock, c.mono, c.mono);
    expect(r).toEqual({ ok: false, reason: 'clock' });
    // Exactly now is also dead.
    expect(expiryFromDeadline(c.wall / 1000, c.clock, c.mono, c.mono)).toEqual({
      ok: false,
      reason: 'clock',
    });
  });

  it('a short server lifetime is kept (below the cap)', () => {
    const c = fakeClock();
    const e = made(expiryFromDeadline((c.wall + 10_000) / 1000, c.clock, c.mono, c.mono));
    expect(msLeft(e, c.clock)).toBe(10_000);
  });
});

describe('the countdown runs on the monotonic clock', () => {
  const start = () => {
    const c = fakeClock();
    const e = made(expiryFromDeadline((c.wall + 60_000) / 1000, c.clock, c.mono, c.mono));
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

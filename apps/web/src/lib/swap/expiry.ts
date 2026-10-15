import {
  CLOCK_SKEW_TOLERANCE_MS,
  QUOTE_LIFETIME_CAP_MS,
  SERVER_CLOCK_GRANULARITY_MS,
} from './config';

/**
 * Quote expiry (ADR 0011, ADR 0012). A signed answer says how long it lives (`ttlSeconds`) and
 * what the server's clock read when it wrote the deadline (`serverTime`). The countdown uses the
 * first and never the device's wall clock: it is counted from the moment the request was *sent*,
 * on the monotonic clock (`performance.now`). The server read its clock after that moment, so the
 * quote cannot outlive what the server meant, whatever the device clock says. `serverTime` is used
 * once, on arrival, to notice a device (or a server) whose clock is far from the other's.
 */
export interface Clock {
  /** Wall clock in milliseconds (`Date.now`). */
  wall: () => number;
  /** Monotonic clock in milliseconds (`performance.now`): it never jumps. */
  mono: () => number;
}

export const realClock: Clock = {
  wall: () => Date.now(),
  mono: () => performance.now(),
};

export interface Expiry {
  /** Monotonic time at which the quote stops being valid. */
  atMono: number;
  /** Wall time at which the answer arrived, and how long the quote was given (for the tripwire). */
  receivedWall: number;
  lifetimeMs: number;
}

/** What the answer says about time (`SwapQuote.serverTimeSec` and `ttlSeconds`). */
export interface QuoteTiming {
  serverTimeSec: number;
  ttlSeconds: number;
}

/** Both clocks read at the moment the request was sent. */
export interface SentAt {
  mono: number;
  wall: number;
}

export type ExpiryResult =
  | { ok: true; expiry: Expiry }
  /** The device clock and the server's disagree by more than the tolerance. */
  | { ok: false; reason: 'clock' }
  /** The answer took as long as the quote lives: it is dead on arrival. */
  | { ok: false; reason: 'late' };

/**
 * How long the quote may be shown, counted from the moment the request was sent: the server's
 * lifetime, less the second the server's whole-second clock may have lost, and never more than
 * the cap. The server writes `deadline = floor(its clock) + ttl` after the request was sent, so
 * `sent + ttl` could be up to one second after the deadline; one second less cannot be.
 */
export function lifetimeFromSentMs(ttlSeconds: number, capMs: number = QUOTE_LIFETIME_CAP_MS) {
  return Math.min(ttlSeconds * 1000 - SERVER_CLOCK_GRANULARITY_MS, capMs);
}

/**
 * True when the device clock and the server's clock are further apart than `toleranceMs`, however
 * slow the answer was. The server read its clock at some real instant between the request being
 * sent and its answer arriving, and wrote it floored to whole seconds. So the device clock minus
 * the server clock (the skew) lies between `sentWall - serverTime * 1000 - 999` and
 * `receivedWall - serverTime * 1000`. Only an interval wholly outside the tolerance counts: the
 * device is ahead when even the smallest possible skew is above it, and behind when even the
 * largest is below minus it.
 */
export function clockDisagrees(
  serverTimeSec: number,
  sentWall: number,
  receivedWall: number,
  toleranceMs: number = CLOCK_SKEW_TOLERANCE_MS,
): boolean {
  const serverMs = serverTimeSec * 1000;
  const skewLow = sentWall - (serverMs + SERVER_CLOCK_GRANULARITY_MS - 1);
  const skewHigh = receivedWall - serverMs;
  return skewLow > toleranceMs || skewHigh < -toleranceMs;
}

/**
 * Turns the answer's timing into an `Expiry`. `sent` and `receivedMono` are the clocks read when
 * the request was sent and when its answer was read.
 *
 * - A device clock that disagrees with the server's (either way) is reported (`clock`) before the
 *   quote is used: the caller shows "Check your clock" and asks nothing again by itself.
 * - The quote runs from the moment the request was sent for `min(ttlSeconds, cap)`, less the
 *   server's one-second clock granularity (`lifetimeFromSentMs`). If an answer was so slow that
 *   nothing is left on arrival it is `late`, never shown.
 */
export function expiryFromTiming(
  timing: QuoteTiming,
  clock: Clock,
  sent: SentAt,
  receivedMono: number,
  capMs: number = QUOTE_LIFETIME_CAP_MS,
): ExpiryResult {
  const receivedWall = clock.wall();
  if (clockDisagrees(timing.serverTimeSec, sent.wall, receivedWall)) {
    return { ok: false, reason: 'clock' };
  }
  const atMono = sent.mono + lifetimeFromSentMs(timing.ttlSeconds, capMs);
  if (atMono <= receivedMono) return { ok: false, reason: 'late' };
  return { ok: true, expiry: { atMono, receivedWall, lifetimeMs: atMono - receivedMono } };
}

/**
 * Whole milliseconds left, never below 0: the less of two readings.
 * - The monotonic clock: `atMono - now`. It never jumps, but it can pause while a device sleeps.
 * - The wall clock: the lifetime minus the wall time since arrival. It sees a sleep, but a person
 *   or NTP can set it. Set backwards it shows more time than the monotonic reading, which is then
 *   the smaller one and wins; set forwards it shows less, which only expires the quote early.
 * So neither a clock set back nor a device that slept can make a quote look longer-lived than it is.
 */
export function msLeft(expiry: Expiry, clock: Clock): number {
  const monoLeft = expiry.atMono - clock.mono();
  const wallLeft = expiry.lifetimeMs - (clock.wall() - expiry.receivedWall);
  return Math.max(0, Math.ceil(Math.min(monoLeft, wallLeft)));
}

/** Seconds to show: rounded up, so "0" is only shown once it is over. */
export function secondsLeft(expiry: Expiry, clock: Clock): number {
  return Math.ceil(msLeft(expiry, clock) / 1000);
}

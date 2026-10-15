import { QUOTE_LIFETIME_CAP_MS } from './config';

/**
 * Quote expiry (ADR 0011). The API sends one absolute deadline in unix seconds, written with the
 * server's clock; the device clock may be seconds or minutes off, so the deadline is never
 * compared with "now" while the quote is on screen. It is used once, to learn how long the quote
 * has left, and from then on the countdown runs on the monotonic clock (`performance.now`).
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

export type ExpiryResult =
  | { ok: true; expiry: Expiry }
  /** The deadline is already past on the device clock: the clock is wrong (or the quote was born dead). */
  | { ok: false; reason: 'clock' };

/**
 * Turns the server deadline into an `Expiry`. `sentMono` and `receivedMono` are the monotonic
 * times at which the request was sent and its answer read.
 *
 * - Time left on arrival is `deadline - wall clock`, one reading, taken at arrival.
 * - It is capped so the quote can never be shown as valid for longer than the cap, counted from
 *   the moment the request was *sent*: the server wrote the deadline somewhere between sending and
 *   arrival, so counting from arrival would add up to one round trip. A device clock that runs
 *   behind would otherwise show a quote as valid for far longer than the server meant.
 * - If nothing is left on arrival the device clock is ahead of the server's by more than the whole
 *   lifetime. Refetching would only produce the same dead quote in a loop, so this is reported
 *   instead (`clock`), and the caller asks the person to fix the time.
 */
export function expiryFromDeadline(
  deadlineSec: number | bigint,
  clock: Clock,
  sentMono: number,
  receivedMono: number,
  capMs: number = QUOTE_LIFETIME_CAP_MS,
): ExpiryResult {
  const receivedWall = clock.wall();
  const leftMs = Number(deadlineSec) * 1000 - receivedWall;
  if (leftMs <= 0) return { ok: false, reason: 'clock' };
  const byDeadline = receivedMono + leftMs;
  const byCap = sentMono + capMs;
  const atMono = Math.min(byDeadline, byCap);
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

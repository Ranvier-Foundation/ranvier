/**
 * Tunables of the swap screen's quote flow, in one place. None of them is a fee, a limit or a
 * promise shown to the user: they are client-side timings and bounds (ADR 0011).
 */

/** Typing must pause this long before a quote is requested. */
export const QUOTE_DEBOUNCE_MS = 400;

/**
 * The signed lifetime the API may answer with, in seconds: the documented range of its
 * `QUOTE_TTL_SECONDS` (ADR 0012, apps/api/src/config.ts: 10 to 600). An answer outside it is not
 * from a correctly configured API and is refused. Named once, here.
 */
export const QUOTE_TTL_MIN_SECONDS = 10;
export const QUOTE_TTL_MAX_SECONDS = 600;

/**
 * Upper bound on how long a quote is shown as valid, counted from the moment the request was
 * sent, whatever the API's `ttlSeconds` says. The quote lasts `min(ttlSeconds, this cap)`
 * (ADR 0011, ADR 0012): a longer API setting only means an earlier refresh on this screen, and a
 * shorter one is followed.
 */
export const QUOTE_LIFETIME_CAP_MS = 60_000;

/**
 * The API writes `serverTime` in whole seconds (its clock, floored), so its signed deadline can
 * fall up to one second before "the moment the request reached it, plus the lifetime". The
 * countdown takes this off the server's lifetime so it can never run past the signed deadline.
 */
export const SERVER_CLOCK_GRANULARITY_MS = 1_000;

/**
 * How far the device clock may be from the server's before the screen says "Check your clock"
 * instead of showing a quote. The countdown does not read the device clock (it runs on the
 * monotonic clock), so this does not protect the countdown: it surfaces a device, or a server,
 * whose time is wrong. The check uses the interval the server's reading must lie in (between the
 * request being sent and its answer arriving), so a slow answer is never mistaken for skew.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;

/**
 * How many times in a row an expired quote is replaced without the person touching anything. After
 * this the screen waits for them (each quote can cost a paid upstream call). Touching the amount,
 * a token or the wallet, pressing the refresh button, or coming back to the tab starts the count over.
 */
export const MAX_IDLE_REFRESHES = 3;

/**
 * Slippage tolerance sent with every quote, in basis points. The canvas draws "Auto" (review
 * screen: "Auto · 0.5%"); smart slippage and the settings screen are later work, so until then
 * this one value is "Auto". It is never shown as a number here: the minimum received comes from
 * the API.
 */
export const AUTO_SLIPPAGE_BPS = 50;

/** Longest text the amount field takes (a uint256 has 78 digits; plus the decimal point). */
export const MAX_AMOUNT_CHARS = 80;

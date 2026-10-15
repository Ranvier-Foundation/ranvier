/**
 * Tunables of the swap screen's quote flow, in one place. None of them is a fee, a limit or a
 * promise shown to the user: they are client-side timings and bounds (ADR 0011).
 */

/** Typing must pause this long before a quote is requested. */
export const QUOTE_DEBOUNCE_MS = 400;

/**
 * Upper bound on how long a quote is shown as valid, counted from the moment the request was
 * sent. The signed quote's validity is 60 seconds (spec section 14; the API's default
 * `QUOTE_TTL_SECONDS`, configurable from 10 to 600). The response carries only an absolute
 * deadline, so this cap is what keeps a device clock that runs behind from showing a quote as valid
 * for longer than the server meant (ADR 0011). A longer API setting only means an earlier refresh.
 */
export const QUOTE_LIFETIME_CAP_MS = 60_000;

/**
 * Slack allowed between the wall clock and the monotonic clock before the quote is treated as
 * expired (a device that slept, or a clock that was set forward while the quote was on screen).
 */
export const QUOTE_CLOCK_TOLERANCE_MS = 2_000;

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

/** Every built screen. The axe scan and the CSP spec both walk this list: add new screens here. */
export const ROUTES: readonly string[] = ['/', '/select-token'];

/** A route that does not exist: the app's own 404 page. */
export const NOT_FOUND_ROUTE = '/this-page-does-not-exist';

/** Nav targets whose screens do not exist yet; Next prefetches them and gets a 404. */
export const UNBUILT_ROUTES: ReadonlySet<string> = new Set([
  '/trade',
  '/buy',
  '/activity',
  '/portfolio',
  '/account',
  '/notifications',
  '/settings',
]);

/**
 * Paths that must still get the strict policy: they guard the proxy matcher against narrowing
 * (a matcher that skipped dotted paths or all of /_next/ passed every other test). Each is answered
 * by the app (HTML: a 404, or `/` for the dot-segment), so each needs the CSP and `no-store`.
 * Sent byte for byte (no URL normalisation) by csp.spec.ts and scripts/check-headers.mjs.
 * (`/_global-error` is not here: the proxy answers it with a plain-text 404, tested on its own.)
 */
export const PROBE_PATHS: readonly string[] = [
  '/robots.txt',
  '/favicon.ico',
  '/nope.',
  '/_next/foo',
  '/%2e%2e/',
  '/a%2fb',
  '/_next/data/x/y.json',
  '/api/x',
  '/_not-found',
];

/**
 * Misses under /_next/static: the only paths the proxy skips (immutable build assets). Next answers
 * them with a plain-text 404 and no CSP; that is correct because the body is never HTML.
 */
export const STATIC_MISS_PATHS: readonly string[] = [
  '/_next/static/nope.js',
  '/_next/static/chunks/nope.css',
];

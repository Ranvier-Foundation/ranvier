/**
 * Security headers for the web app (spec section 9, frontend hijack protection; ADR 0008).
 *
 * The Content-Security-Policy is built per request by `src/proxy.ts`, with a fresh nonce:
 * Next.js reads the nonce from the request's CSP header and puts it on every script it renders
 * (framework, page chunks, the inline RSC payload). `'strict-dynamic'` lets those scripts load
 * further chunks; nothing else runs. Every route is rendered dynamically for this
 * (`connection()` in the root layout), because a prerendered page cannot carry a per-request nonce.
 *
 * The other headers do not vary per request and are set in next.config.ts.
 *
 * This module is pure (no Next imports) so it can be unit tested and shared by both.
 */

/** Loopback hosts, where plain http is acceptable even in a production build. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API origin the browser may call, from NEXT_PUBLIC_API_URL. Read at BUILD time: Next bakes
 * NEXT_PUBLIC_* values into the build (next.config.ts calls this so a bad value fails the build),
 * so changing it needs a rebuild. Only the origin is used, never a path; anything but an http(s)
 * URL throws, so a typo cannot widen `connect-src`. A production build refuses plain http unless
 * the host is loopback. Unset or empty: same-origin only.
 */
export function apiOrigin(apiUrl: string | undefined, nodeEnv?: string): string | undefined {
  const raw = apiUrl?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL must be an absolute http(s) URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('NEXT_PUBLIC_API_URL must be an http(s) URL without credentials');
  }
  // Hosts may contain characters such as `;` or `'` that would end or alter the CSP directive.
  if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(url.origin)) {
    throw new Error('NEXT_PUBLIC_API_URL host is not a plain DNS name or IP address');
  }
  if (
    nodeEnv?.trim().toLowerCase() === 'production' &&
    url.protocol === 'http:' &&
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    throw new Error('NEXT_PUBLIC_API_URL must use https in production (loopback excepted)');
  }
  return url.origin;
}

/** Nonce size: 128 bits, as CSP3 recommends. */
export const NONCE_BYTES = 16;

/** Standard base64 of exactly 16 bytes: 22 characters plus `==`. */
const NONCE_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

/** A fresh nonce from the platform CSPRNG (Web Crypto), base64. Never reuse one. */
export function createNonce(
  fill: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b),
): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  fill(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export interface CspInput {
  /** From `createNonce()`. Anything else throws, so a value cannot alter the policy. */
  nonce: string;
  /** From `apiOrigin()`; undefined means same-origin only. */
  api: string | undefined;
  /**
   * `next dev` only: React needs `eval` there to rebuild server error stacks. Never set for a
   * production build (a unit test asserts the production policy has no `unsafe-eval`).
   */
  dev: boolean;
}

/**
 * The policy (ADR 0008). Each directive:
 * - `default-src 'none'`: anything not listed below is refused.
 * - `script-src`: only scripts carrying this response's nonce, plus what they load
 *   (`'strict-dynamic'`). No `'self'`, no hosts, no `'unsafe-inline'`: an injected `<script>`,
 *   event handler, `javascript:` URL or same-origin chunk gadget does not run.
 *   `'report-sample'` puts the first characters of a blocked script into the violation.
 * - `style-src 'self'` plus the nonce: our stylesheet files and Next's own nonced tags. The app
 *   emits no inline styles (ESLint forbids them), so no `'unsafe-inline'`.
 * - `img-src 'self' data:`: wallet icons arrive as data: URIs (EIP-6963). Token logos will be
 *   served from our own origin, never from arbitrary hosts.
 * - `connect-src`: our origin and the API origin only. Chain reads go through the API (ADR 0008),
 *   so no RPC origins are ever added here. Wallet requests go through the extension, not fetch.
 * - `frame-ancestors 'none'`, `frame-src 'none'`, `object-src 'none'`, `worker-src 'none'`,
 *   `base-uri 'none'`, `form-action 'self'`, `manifest-src 'self'`, `font-src 'self'`.
 * No reporting directives yet: the report endpoint is a later change.
 */
export function contentSecurityPolicy({ nonce, api, dev }: CspInput): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error('CSP nonce must be 16 bytes of base64');
  const n = `'nonce-${nonce}'`;
  return [
    "default-src 'none'",
    `script-src ${n} 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''} 'report-sample'`,
    `style-src 'self' ${n}`,
    "img-src 'self' data:",
    "font-src 'self'",
    api ? `connect-src 'self' ${api}` : "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

export type CspHeaderName = 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only';

/**
 * `CSP_REPORT_ONLY=1` (exactly) sends the same policy as Report-Only, for a first staging run
 * behind the real proxy and CDN (docs/runbooks/web-deployment-headers.md). Anything else enforces.
 */
export function cspHeaderName(reportOnlyFlag: string | undefined): CspHeaderName {
  return reportOnlyFlag === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

/**
 * Headers that do not change per request, for every response (pages and static assets).
 * - HSTS with preload: the header is ready; submission to the preload list waits for the
 *   production domain (ADR 0008).
 * - `Referrer-Policy: no-referrer`: no flow needs a Referer; the API checks `Origin`. Future URLs
 *   may carry addresses or amounts, which must not leak to other sites.
 * - `Permissions-Policy`: every powerful feature the app does not use is off for us and any frame.
 *   Hardware wallets over WebHID would need `hid=(self)`: a deliberate change.
 * - `Cross-Origin-Opener-Policy: same-origin`: no other window keeps a handle on ours
 *   (tab-nabbing, cross-window leaks). A popup wallet SDK would need `same-origin-allow-popups`
 *   (ADR 0007 makes adding one a deliberate change).
 * - `Cross-Origin-Resource-Policy: same-origin`: other sites cannot embed our responses.
 * - `X-Frame-Options: DENY` for browsers without `frame-ancestors`.
 */
export function staticSecurityHeaders(): { key: string; value: string }[] {
  return [
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    {
      key: 'Permissions-Policy',
      value:
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), browsing-topics=()',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  ];
}

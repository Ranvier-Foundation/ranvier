import { NextResponse, type NextRequest } from 'next/server';
import { apiOrigin, contentSecurityPolicy, createNonce, cspDelivery } from '@/lib/security/csp';

/**
 * Baked in at build by next.config.ts (`env`), already validated there; never read from the
 * runtime environment, so a variable set on the server cannot widen `connect-src`.
 */
const API = apiOrigin(process.env.RANVIER_BUILD_API_ORIGIN, process.env.NODE_ENV);
const DEV = process.env.NODE_ENV === 'development';
/** Runtime settings, decided once per process; the warning is logged by src/instrumentation.ts. */
const DELIVERY = cspDelivery({
  CSP_REPORT_ONLY: process.env.CSP_REPORT_ONLY,
  RANVIER_ENV: process.env.RANVIER_ENV,
});

/**
 * Next's built-in `/_global-error` route is reachable by URL and is prerendered (cacheable, no
 * nonces). It is only meant to render inside a failing request, never by address, so a direct
 * request gets the app's 404 instead, under the same policy.
 */
const GLOBAL_ERROR_ROUTE = /^\/_global-error(?:[/.]|$)/;

/**
 * Strict CSP with a fresh nonce per request (ADR 0008). Next.js reads the nonce from the CSP
 * header on the forwarded request and adds it to every script and stylesheet it renders; the
 * browser gets the same policy on the response. Any CSP header the client sent is dropped first,
 * so only ours reaches the renderer.
 */
export function proxy(request: NextRequest) {
  const policy = contentSecurityPolicy({ nonce: createNonce(), api: API, dev: DEV });
  const name = DELIVERY.header;
  const forwarded = new Headers(request.headers);
  forwarded.delete('content-security-policy');
  forwarded.delete('content-security-policy-report-only');
  forwarded.set(name, policy);
  const init = { request: { headers: forwarded } };
  const response = GLOBAL_ERROR_ROUTE.test(request.nextUrl.pathname)
    ? NextResponse.rewrite(new URL('/_not-found', request.url), init)
    : NextResponse.next(init);
  response.headers.set(name, policy);
  return response;
}

/**
 * Every request except build assets (immutable files under /_next/static, which are never HTML).
 * Prefetch and RSC requests are included on purpose: a header on them costs nothing, and no
 * request that renders a page can skip the policy. tests/unit/security-headers.test.ts runs this
 * matcher through Next's own compiler and asserts that only /_next/static/* bypasses it.
 */
export const config = {
  matcher: ['/((?!_next/static/).*)'],
};

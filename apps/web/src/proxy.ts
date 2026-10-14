import { NextResponse, type NextRequest } from 'next/server';
import { apiOrigin, contentSecurityPolicy, createNonce, cspHeaderName } from '@/lib/security/csp';

/** Validated at build time by next.config.ts; NEXT_PUBLIC_* values are baked into the build. */
const API = apiOrigin(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);
const DEV = process.env.NODE_ENV === 'development';

/**
 * Strict CSP with a fresh nonce per request (ADR 0008). Next.js reads the nonce from the CSP
 * header on the forwarded request and adds it to every script and stylesheet it renders; the
 * browser gets the same policy on the response. Any CSP header the client sent is dropped first,
 * so only ours reaches the renderer.
 */
export function proxy(request: NextRequest) {
  const policy = contentSecurityPolicy({ nonce: createNonce(), api: API, dev: DEV });
  const name = cspHeaderName(process.env.CSP_REPORT_ONLY);
  const forwarded = new Headers(request.headers);
  forwarded.delete('content-security-policy');
  forwarded.delete('content-security-policy-report-only');
  forwarded.set(name, policy);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(name, policy);
  return response;
}

/**
 * Every request except build assets (immutable files under /_next/static, which are never HTML).
 * Prefetch and RSC requests are included on purpose: a header on them costs nothing, and no
 * request that renders a page can skip the policy.
 */
export const config = {
  matcher: ['/((?!_next/static/).*)'],
};

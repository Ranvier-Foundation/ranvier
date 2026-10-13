import path from 'node:path';
import type { NextConfig } from 'next';

/** Loopback hosts, where plain http is acceptable even in a production build. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API origin the browser may call, from NEXT_PUBLIC_API_URL. Read at BUILD time: Next bakes
 * these headers (and NEXT_PUBLIC_* values) into the build, so changing it needs a rebuild.
 * Only the origin is used, never a path; anything but an http(s) URL fails the build, so a typo
 * cannot widen `connect-src`. A production build (`next build` sets NODE_ENV=production)
 * refuses plain http unless the host is loopback. Unset or empty: same-origin only.
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

// Spec section 9: frontend hijack protection. This CSP is static and NOT yet strict:
// `script-src` still has 'unsafe-inline' (Next inlines its bootstrap scripts). Wallet code is now
// in the app (wagmi, ADR 0007), so any script injection can reach wallet requests. A strict
// policy (per-request nonces with 'strict-dynamic', and SRI) is required BEFORE any signing or
// transaction flow ships; it is tracked as its own change, not done here.
export function securityHeaders(
  apiUrl: string | undefined,
  nodeEnv?: string,
): { key: string; value: string }[] {
  const api = apiOrigin(apiUrl, nodeEnv);
  return [
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    {
      key: 'Content-Security-Policy',
      value: [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        api ? `connect-src 'self' ${api}` : "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    },
  ];
}

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV),
      },
    ];
  },
};

export default config;

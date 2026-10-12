import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The API origin the browser may call, from NEXT_PUBLIC_API_URL (read at build and start).
 * Only the origin is used, never a path; anything but an http(s) URL fails the build, so a typo
 * cannot widen `connect-src`. Unset or empty: same-origin only.
 */
export function apiOrigin(apiUrl: string | undefined): string | undefined {
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
  return url.origin;
}

// Spec section 9: frontend hijack protection. The CSP moves to per-request nonces
// once wallet SDKs are added; until then it is strict and static.
export function securityHeaders(apiUrl: string | undefined): { key: string; value: string }[] {
  const api = apiOrigin(apiUrl);
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
    return [{ source: '/:path*', headers: securityHeaders(process.env.NEXT_PUBLIC_API_URL) }];
  },
};

export default config;

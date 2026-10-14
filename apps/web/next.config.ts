import path from 'node:path';
import type { NextConfig } from 'next';
import { apiOrigin, staticSecurityHeaders } from './src/lib/security/csp.ts';

// Spec section 9, frontend hijack protection (ADR 0008). The Content-Security-Policy is NOT set
// here: it carries a per-request nonce, so src/proxy.ts builds it for every request (strict
// policy: nonce + 'strict-dynamic', no 'unsafe-inline' for scripts or styles). This file sets the
// headers that never change per request, and decides the API origin for `connect-src` at build
// time: a bad NEXT_PUBLIC_API_URL fails the build, and the validated origin is baked into the
// build as RANVIER_BUILD_API_ORIGIN (empty when unset), so the runtime environment cannot change it.
const BUILD_API_ORIGIN = apiOrigin(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV) ?? '';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  poweredByHeader: false,
  env: { RANVIER_BUILD_API_ORIGIN: BUILD_API_ORIGIN },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: staticSecurityHeaders(),
      },
    ];
  },
};

export default config;

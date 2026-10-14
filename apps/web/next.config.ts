import path from 'node:path';
import type { NextConfig } from 'next';
import { apiOrigin, staticSecurityHeaders } from './src/lib/security/csp.ts';

// Spec section 9, frontend hijack protection (ADR 0008). The Content-Security-Policy is NOT set
// here: it carries a per-request nonce, so src/proxy.ts builds it for every request (strict
// policy: nonce + 'strict-dynamic', no 'unsafe-inline' for scripts or styles). This file sets the
// headers that never change per request. Validating NEXT_PUBLIC_API_URL here makes a bad value
// fail the build instead of the first request.
apiOrigin(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  poweredByHeader: false,
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

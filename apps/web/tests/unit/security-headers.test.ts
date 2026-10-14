import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createRequire } from 'node:module';
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher.js';
import {
  apiOrigin,
  contentSecurityPolicy,
  createNonce,
  cspDelivery,
  NONCE_BYTES,
  staticSecurityHeaders,
} from '../../src/lib/security/csp.ts';
import { config as proxyConfig } from '../../src/proxy.ts';

/** Next's own matcher compiler (internal, not in its type declarations): exact build semantics. */
const { getMiddlewareMatchers } = createRequire(import.meta.url)(
  'next/dist/build/analysis/get-page-static-info.js',
) as {
  getMiddlewareMatchers: (
    matcher: unknown,
    nextConfig: { basePath: string; i18n: null },
  ) => { regexp: string; originalSource: string }[];
};

/** The proxy reads its settings once at module load: import a fresh copy per environment. */
async function loadProxy(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('../../src/proxy.ts')).proxy;
}

/** A fixed, valid nonce (16 bytes of base64) for exact comparisons. */
const NONCE = 'AAECAwQFBgcICQoLDA0ODw==';
const policy = (apiUrl: string | undefined, dev = false): string =>
  contentSecurityPolicy({ nonce: NONCE, api: apiOrigin(apiUrl), dev });
const directive = (p: string, name: string): string | undefined =>
  p.split('; ').find((d) => d === name || d.startsWith(`${name} `));
const sources = (p: string, name: string): string[] =>
  (directive(p, name) ?? '').split(' ').slice(1);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('content security policy', () => {
  it('is exactly the ADR 0008 policy (fixed nonce, no API origin)', () => {
    expect(policy(undefined)).toBe(
      [
        "default-src 'none'",
        `script-src 'nonce-${NONCE}' 'strict-dynamic' 'report-sample'`,
        `style-src 'self' 'nonce-${NONCE}'`,
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "worker-src 'none'",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
  });

  it('production: scripts run only by nonce; no unsafe-*, no self, no host, no scheme', () => {
    for (const api of [undefined, 'https://api.ranvier.example']) {
      const p = policy(api);
      expect(p).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|wasm-unsafe-eval/);
      expect(sources(p, 'script-src')).toEqual([
        `'nonce-${NONCE}'`,
        "'strict-dynamic'",
        "'report-sample'",
      ]);
      expect(sources(p, 'style-src')).toEqual(["'self'", `'nonce-${NONCE}'`]);
      expect(p).not.toContain('*');
    }
  });

  it("next dev only: 'unsafe-eval' for scripts, 'unsafe-inline' (no nonce) for styles", () => {
    const dev = policy(undefined, true);
    expect(sources(dev, 'script-src')).toEqual([
      `'nonce-${NONCE}'`,
      "'strict-dynamic'",
      "'unsafe-eval'",
      "'report-sample'",
    ]);
    expect(sources(dev, 'style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(dev.match(/'unsafe-[a-z-]+'/g)).toEqual(["'unsafe-eval'", "'unsafe-inline'"]);
    // Everything else is identical to production.
    const rest = (p: string) =>
      p.split('; ').filter((d) => !d.startsWith('script-src') && !d.startsWith('style-src'));
    expect(rest(dev)).toEqual(rest(policy(undefined)));
  });

  it('refuses a nonce that is not 16 bytes of base64 (cannot alter the policy)', () => {
    for (const nonce of [
      '',
      'abc',
      `${NONCE}'; script-src *`,
      'AAECAwQFBgcICQoLDA0ODw=',
      'AAECAwQFBgcICQoLDA0ODxA=',
      'AAECAwQFBgcICQoLDA0OD w==',
    ]) {
      expect(() => contentSecurityPolicy({ nonce, api: undefined, dev: false })).toThrow(/nonce/);
    }
  });

  it('wallet connection adds nothing: no RPC, relay or WebSocket origin, data: images only', () => {
    const p = policy('https://api.ranvier.example');
    expect(directive(p, 'connect-src')).toBe("connect-src 'self' https://api.ranvier.example");
    expect(p).not.toMatch(/wss?:|walletconnect|reown|https:(?!\/\/api\.ranvier\.example)/);
    expect(directive(p, 'img-src')).toBe("img-src 'self' data:");
  });

  it('no reporting directives yet (the report endpoint is a later change)', () => {
    expect(policy('https://api.ranvier.example')).not.toMatch(/report-uri|report-to/);
  });

  it('Report-Only needs CSP_REPORT_ONLY=1 AND RANVIER_ENV=staging, exact values', () => {
    expect(cspDelivery({ CSP_REPORT_ONLY: '1', RANVIER_ENV: 'staging' })).toEqual({
      header: 'Content-Security-Policy-Report-Only',
      warning: expect.stringMatching(/^CSP IS NOT ENFORCED/) as unknown as string,
    });
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 '])
      for (const e of [undefined, 'staging', 'production']) {
        expect(cspDelivery({ CSP_REPORT_ONLY: v, RANVIER_ENV: e })).toEqual({
          header: 'Content-Security-Policy',
        });
      }
  });

  it('CSP_REPORT_ONLY=1 without RANVIER_ENV=staging is ignored (enforced) and warns', () => {
    for (const e of [undefined, '', 'production', 'Staging', ' staging', 'staging ', 'prod']) {
      const d = cspDelivery({ CSP_REPORT_ONLY: '1', RANVIER_ENV: e });
      expect(d.header).toBe('Content-Security-Policy');
      expect(d.warning).toMatch(/^CSP_REPORT_ONLY=1 IGNORED: .* ENFORCED/);
    }
    // The echoed value is bounded and quoted.
    const long = cspDelivery({ CSP_REPORT_ONLY: '1', RANVIER_ENV: 'x'.repeat(500) });
    expect(long.warning?.length).toBeLessThan(200);
  });
});

describe('nonce', () => {
  it('is 128 bits of base64', () => {
    expect(NONCE_BYTES).toBe(16);
    const n = createNonce();
    expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Uint8Array.from(atob(n), (c) => c.charCodeAt(0))).toHaveLength(16);
  });

  it('encodes exactly the random bytes it is given', () => {
    const n = createNonce((b) => b.set(Array.from({ length: 16 }, (_, i) => i)));
    expect(n).toBe(NONCE);
  });

  it('is different on every call', () => {
    const seen = new Set(Array.from({ length: 10_000 }, () => createNonce()));
    expect(seen.size).toBe(10_000);
  });
});

describe('proxy', () => {
  const request = (path = '/', headers: Record<string, string> = {}) =>
    new NextRequest(`http://127.0.0.1:3100${path}`, { headers });
  /** NextResponse.next({ request }) forwards request headers as x-middleware-request-*. */
  const forwarded = (res: Response, name: string) =>
    res.headers.get(`x-middleware-request-${name}`);

  it('sends the policy on the response and forwards the same one to the renderer', async () => {
    const res = (await loadProxy())(request());
    const sent = res.headers.get('content-security-policy');
    expect(sent).toMatch(/^default-src 'none'; script-src 'nonce-[A-Za-z0-9+/]{22}==' /);
    expect(forwarded(res, 'content-security-policy')).toBe(sent);
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('uses a new nonce per request', async () => {
    const proxy = await loadProxy();
    const nonce = (r: Response) =>
      /'nonce-([^']+)'/.exec(r.headers.get('content-security-policy') ?? '')?.[1];
    const a = nonce(proxy(request()));
    expect(a).toBeDefined();
    expect(nonce(proxy(request()))).not.toBe(a);
  });

  it('drops any CSP the client sent, so it cannot choose the nonce', async () => {
    const res = (await loadProxy())(
      request('/', {
        'content-security-policy': "script-src 'nonce-attackerchosen0000000000=='",
        'content-security-policy-report-only': "script-src 'nonce-attackerchosen0000000000=='",
      }),
    );
    expect(forwarded(res, 'content-security-policy')).not.toContain('attackerchosen');
    expect(forwarded(res, 'content-security-policy-report-only')).toBeNull();
  });

  it('CSP_REPORT_ONLY=1 with RANVIER_ENV=staging: same policy as Report-Only only', async () => {
    const proxy = await loadProxy({ CSP_REPORT_ONLY: '1', RANVIER_ENV: 'staging' });
    const res = proxy(
      request('/', { 'content-security-policy': "script-src 'nonce-attackerchosen0000000000=='" }),
    );
    expect(res.headers.get('content-security-policy')).toBeNull();
    const sent = res.headers.get('content-security-policy-report-only');
    expect(sent).toMatch(/^default-src 'none'; script-src 'nonce-/);
    expect(forwarded(res, 'content-security-policy-report-only')).toBe(sent);
    expect(forwarded(res, 'content-security-policy')).toBeNull();
  });

  it('CSP_REPORT_ONLY=1 outside staging still enforces', async () => {
    for (const env of [
      { CSP_REPORT_ONLY: '1' },
      { CSP_REPORT_ONLY: '1', RANVIER_ENV: 'production' },
    ]) {
      const res = (await loadProxy(env))(request());
      expect(res.headers.get('content-security-policy')).toMatch(/^default-src 'none'/);
      expect(res.headers.get('content-security-policy-report-only')).toBeNull();
      vi.unstubAllEnvs();
    }
  });

  it('connect-src comes from the build-time origin only, never NEXT_PUBLIC_API_URL', async () => {
    const res = (await loadProxy({ NEXT_PUBLIC_API_URL: 'https://evil.example' }))(request());
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self';");
    vi.unstubAllEnvs();
    const baked = (await loadProxy({ RANVIER_BUILD_API_ORIGIN: 'https://api.ranvier.example' }))(
      request(),
    );
    expect(baked.headers.get('content-security-policy')).toContain(
      "connect-src 'self' https://api.ranvier.example;",
    );
  });

  it('a direct request to /_global-error gets a plain 404 from the proxy, no rewrite', async () => {
    const proxy = await loadProxy();
    const forwardedProto = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.com' };
    for (const path of [
      '/_global-error',
      '/_global-error/',
      '/_global-error.html',
      '/_global-error.rsc',
    ]) {
      for (const headers of [{}, forwardedProto, { ...forwardedProto, rsc: '1' }]) {
        const res = proxy(request(path, headers));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('Not Found');
        expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(res.headers.get('cache-control')).toBe('no-store');
        // Answered here: nothing is rewritten, forwarded or fetched.
        expect(res.headers.get('x-middleware-rewrite')).toBeNull();
        expect(res.headers.get('x-middleware-next')).toBeNull();
        expect(res.headers.get('content-security-policy')).toMatch(/^default-src 'none'/);
      }
    }
    for (const path of ['/_global-errors', '/x/_global-error', '/', '/x.rsc']) {
      const res = proxy(request(path, forwardedProto));
      expect(res.headers.get('x-middleware-next')).toBe('1');
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    }
  });

  // NODE_ENV is 'test' here; the production build's header is checked by e2e (csp.spec.ts).
  it('adds no unsafe-eval outside next dev', async () => {
    const res = (await loadProxy())(request());
    expect(res.headers.get('content-security-policy')).not.toContain('unsafe-eval');
  });
});

describe('proxy matcher (compiled and matched by Next itself)', () => {
  const runs = getMiddlewareRouteMatcher(
    getMiddlewareMatchers(proxyConfig.matcher, { basePath: '', i18n: null }),
  );
  const matches = (path: string) => runs(path, { headers: {} } as never, {});

  it('covers every path except /_next/static/*', () => {
    const covered = [
      '/',
      '/index',
      '/robots.txt',
      '/favicon.ico',
      '/sitemap.xml',
      '/nope.',
      '/a.b.c',
      '/_next',
      '/_next/',
      '/_next/foo',
      '/_next/staticx',
      '/_next/static',
      '/_next/image',
      '/_next/data/x/y.json',
      '/_global-error',
      '/_not-found',
      '/api/x',
      '/%2e%2e/',
      '/a%2fb',
      '/trade/',
      '/x.rsc',
      '/.well-known/security.txt',
    ];
    expect(covered.filter((p) => !matches(p))).toEqual([]);
    const bypass = ['/_next/static/chunks/a.js', '/_next/static/x.css', '/_next/static/'];
    expect(bypass.filter((p) => matches(p))).toEqual([]);
  });
});

describe('static security headers', () => {
  it('are exactly the ADR 0008 set, without any CSP', () => {
    expect(Object.fromEntries(staticSecurityHeaders().map((h) => [h.key, h.value]))).toEqual({
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), browsing-topics=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  });
});

describe('API origin (connect-src)', () => {
  it('is same-origin only when NEXT_PUBLIC_API_URL is unset or empty', () => {
    expect(directive(policy(undefined), 'connect-src')).toBe("connect-src 'self'");
    expect(directive(policy(''), 'connect-src')).toBe("connect-src 'self'");
    expect(directive(policy('  '), 'connect-src')).toBe("connect-src 'self'");
  });

  it('adds exactly the API origin, without path, query or trailing slash', () => {
    expect(directive(policy('http://localhost:4000'), 'connect-src')).toBe(
      "connect-src 'self' http://localhost:4000",
    );
    expect(directive(policy('https://API.Ranvier.example/v1/?x=1#y'), 'connect-src')).toBe(
      "connect-src 'self' https://api.ranvier.example",
    );
    expect(apiOrigin('https://api.ranvier.example:443/')).toBe('https://api.ranvier.example');
    expect(apiOrigin('http://[::1]:4000')).toBe('http://[::1]:4000');
  });

  it.each([
    'api.ranvier.example',
    '*',
    'https://*.ranvier.example',
    'ftp://api.ranvier.example',
    'javascript:alert(1)',
    'data:text/plain,x',
    'https://user:pw@api.ranvier.example',
    "https://api.ranvier.example;script-src 'unsafe-eval'",
    'https://a;b.example',
    "https://a'b.example",
  ])('refuses %s', (value) => {
    expect(() => apiOrigin(value)).toThrow(/NEXT_PUBLIC_API_URL/);
  });

  it('refuses plain http in a production build unless the host is loopback', () => {
    for (const nodeEnv of ['production', ' PRODUCTION ']) {
      expect(() => apiOrigin('http://api.ranvier.example', nodeEnv)).toThrow(/https in production/);
      expect(() => apiOrigin('http://localhost.evil.example', nodeEnv)).toThrow(
        /https in production/,
      );
    }
    expect(apiOrigin('https://api.ranvier.example', 'production')).toBe(
      'https://api.ranvier.example',
    );
    for (const local of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']) {
      expect(apiOrigin(local, 'production')).toBe(local);
    }
    expect(apiOrigin(undefined, 'production')).toBeUndefined();
    // Development and test builds accept http for any host.
    expect(apiOrigin('http://192.168.1.5:4000', 'development')).toBe('http://192.168.1.5:4000');
    expect(apiOrigin('http://api.ranvier.example')).toBe('http://api.ranvier.example');
  });

  it('a bad NEXT_PUBLIC_API_URL fails next.config.ts, i.e. the build', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_API_URL', "https://a'b.example");
    await expect(import('../../next.config.ts')).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.ranvier.example');
    await expect(import('../../next.config.ts')).resolves.toBeDefined();
  });

  it('next.config.ts bakes the validated origin into the build (empty when unset)', async () => {
    const envOf = async (value: string | undefined) => {
      vi.resetModules();
      vi.stubEnv('NEXT_PUBLIC_API_URL', value ?? '');
      return (await import('../../next.config.ts')).default.env;
    };
    expect(await envOf('https://API.ranvier.example/v1?x')).toEqual({
      RANVIER_BUILD_API_ORIGIN: 'https://api.ranvier.example',
    });
    expect(await envOf(undefined)).toEqual({ RANVIER_BUILD_API_ORIGIN: '' });
  });
});

describe('startup warning (instrumentation)', () => {
  const warnings = async (env: Record<string, string>) => {
    vi.resetModules();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (await import('../../src/instrumentation.ts')).register();
    const calls = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    return calls;
  };

  it('is silent when enforcing normally', async () => {
    expect(await warnings({})).toEqual([]);
  });

  it('warns once when Report-Only is on (staging)', async () => {
    const w = await warnings({ CSP_REPORT_ONLY: '1', RANVIER_ENV: 'staging' });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('CSP IS NOT ENFORCED');
  });

  it('warns once when a stray CSP_REPORT_ONLY=1 is ignored', async () => {
    const w = await warnings({ CSP_REPORT_ONLY: '1', RANVIER_ENV: 'production' });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('CSP_REPORT_ONLY=1 IGNORED');
  });
});

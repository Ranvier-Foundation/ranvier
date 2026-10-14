import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  apiOrigin,
  contentSecurityPolicy,
  createNonce,
  cspHeaderName,
  NONCE_BYTES,
  staticSecurityHeaders,
} from '../../src/lib/security/csp.ts';
import { proxy } from '../../src/proxy.ts';

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

  it('sends Report-Only only for CSP_REPORT_ONLY=1 exactly', () => {
    expect(cspHeaderName('1')).toBe('Content-Security-Policy-Report-Only');
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1'])
      expect(cspHeaderName(v)).toBe('Content-Security-Policy');
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
  const run = (headers: Record<string, string> = {}) =>
    proxy(new NextRequest('http://127.0.0.1:3100/', { headers }));
  /** NextResponse.next({ request }) forwards request headers as x-middleware-request-*. */
  const forwarded = (res: Response, name: string) =>
    res.headers.get(`x-middleware-request-${name}`);

  it('sends the policy on the response and forwards the same one to the renderer', () => {
    const res = run();
    const sent = res.headers.get('content-security-policy');
    expect(sent).toMatch(/^default-src 'none'; script-src 'nonce-[A-Za-z0-9+/]{22}==' /);
    expect(forwarded(res, 'content-security-policy')).toBe(sent);
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
  });

  it('uses a new nonce per request', () => {
    const nonce = (r: Response) =>
      /'nonce-([^']+)'/.exec(r.headers.get('content-security-policy') ?? '')?.[1];
    const a = nonce(run());
    expect(a).toBeDefined();
    expect(nonce(run())).not.toBe(a);
  });

  it('drops any CSP the client sent, so it cannot choose the nonce', () => {
    const res = run({
      'content-security-policy': "script-src 'nonce-attackerchosen0000000000=='",
      'content-security-policy-report-only': "script-src 'nonce-attackerchosen0000000000=='",
    });
    expect(forwarded(res, 'content-security-policy')).not.toContain('attackerchosen');
    expect(forwarded(res, 'content-security-policy-report-only')).toBeNull();
  });

  it('CSP_REPORT_ONLY=1 sends the same policy as Report-Only and no enforced policy', () => {
    vi.stubEnv('CSP_REPORT_ONLY', '1');
    const res = run({ 'content-security-policy': "script-src 'nonce-attackerchosen0000000000=='" });
    expect(res.headers.get('content-security-policy')).toBeNull();
    const sent = res.headers.get('content-security-policy-report-only');
    expect(sent).toMatch(/^default-src 'none'; script-src 'nonce-/);
    expect(forwarded(res, 'content-security-policy-report-only')).toBe(sent);
    expect(forwarded(res, 'content-security-policy')).toBeNull();
  });

  // NODE_ENV is 'test' here; the production build's header is checked by e2e (csp.spec.ts).
  it('adds no unsafe-eval outside next dev', () => {
    expect(run().headers.get('content-security-policy')).not.toContain('unsafe-eval');
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
});

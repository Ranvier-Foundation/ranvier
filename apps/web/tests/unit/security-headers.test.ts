import { describe, expect, it } from 'vitest';
import { apiOrigin, securityHeaders } from '../../next.config.ts';

const csp = (apiUrl: string | undefined): string => {
  const header = securityHeaders(apiUrl).find((h) => h.key === 'Content-Security-Policy');
  if (!header) throw new Error('no CSP');
  return header.value;
};
const directive = (policy: string, name: string): string | undefined =>
  policy.split('; ').find((d) => d.startsWith(`${name} `));

describe('security headers: connect-src', () => {
  it('is same-origin only when NEXT_PUBLIC_API_URL is unset or empty', () => {
    expect(directive(csp(undefined), 'connect-src')).toBe("connect-src 'self'");
    expect(directive(csp(''), 'connect-src')).toBe("connect-src 'self'");
    expect(directive(csp('  '), 'connect-src')).toBe("connect-src 'self'");
  });

  it('adds exactly the API origin, without path, query or trailing slash', () => {
    expect(directive(csp('http://localhost:4000'), 'connect-src')).toBe(
      "connect-src 'self' http://localhost:4000",
    );
    expect(directive(csp('https://API.Ranvier.example/v1/?x=1#y'), 'connect-src')).toBe(
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
  ])('refuses %s at build time', (value) => {
    expect(() => securityHeaders(value)).toThrow(/NEXT_PUBLIC_API_URL/);
  });

  it('refuses plain http in a production build unless the host is loopback', () => {
    for (const nodeEnv of ['production', ' PRODUCTION ']) {
      expect(() => securityHeaders('http://api.ranvier.example', nodeEnv)).toThrow(
        /https in production/,
      );
      expect(() => securityHeaders('http://localhost.evil.example', nodeEnv)).toThrow(
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

  it('leaves every other header and directive unchanged', () => {
    const without = securityHeaders(undefined);
    const withApi = securityHeaders('https://api.ranvier.example');
    expect(withApi.map((h) => h.key)).toEqual(without.map((h) => h.key));
    for (const [i, h] of without.entries()) {
      if (h.key !== 'Content-Security-Policy') expect(withApi[i]).toEqual(h);
    }
    const other = (policy: string) =>
      policy.split('; ').filter((d) => !d.startsWith('connect-src '));
    expect(other(csp('https://api.ranvier.example'))).toEqual(other(csp(undefined)));
    expect(csp(undefined)).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    expect(csp('https://api.ranvier.example')).not.toContain('*');
  });

  it('wallet connection adds nothing: no RPC, relay or WebSocket origin, data: images only', () => {
    const policy = csp('https://api.ranvier.example');
    expect(directive(policy, 'connect-src')).toBe("connect-src 'self' https://api.ranvier.example");
    expect(policy).not.toMatch(/wss?:|walletconnect|reown|\*/);
    expect(directive(policy, 'img-src')).toBe("img-src 'self' data:");
  });
});

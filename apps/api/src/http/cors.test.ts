import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { CORS_ALLOWED_HEADERS, CORS_ALLOWED_METHODS, CORS_MAX_AGE_SECONDS } from './cors.js';
import { buildServer } from './server.js';

const WEB = 'http://localhost:3000';
const APP = 'https://app.ranvier.example';
const EVIL = 'https://evil.example';

type Method = 'GET' | 'POST' | 'OPTIONS';

function call(
  method: Method,
  url: string,
  headers: Record<string, string>,
  webOrigins: readonly string[] = [WEB, APP],
  payload?: Record<string, unknown>,
) {
  return buildServer({ providers: [], servedChainIds: [1], webOrigins }).inject({
    method,
    url,
    headers,
    ...(payload ? { payload } : {}),
  });
}

const corsHeaders = (headers: Record<string, unknown>) =>
  Object.keys(headers).filter((h) => h.startsWith('access-control-'));

describe('CORS (ADR 0006)', () => {
  it('grants an allowed origin by echoing it, never a wildcard or credentials', async () => {
    for (const origin of [WEB, APP]) {
      const res = await call('GET', '/v1/chains', { origin });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['access-control-expose-headers']).toBeUndefined();
      expect(res.headers.vary).toBe('Origin');
    }
  });

  it('serves a disallowed origin without any CORS header', async () => {
    for (const origin of [
      EVIL,
      'null',
      `${WEB}/`,
      'http://LOCALHOST:3000',
      'http://localhost:3001',
    ]) {
      const res = await call('GET', '/v1/tokens?chain=evm:1', { origin });
      expect(res.statusCode, origin).toBe(200);
      expect(corsHeaders(res.headers), origin).toEqual([]);
      expect(res.headers.vary).toBe('Origin');
    }
  });

  it('adds Vary: Origin to same-origin requests and keeps the cache header', async () => {
    const res = await call('GET', '/v1/tokens?chain=evm:1', {});
    expect(corsHeaders(res.headers)).toEqual([]);
    expect(res.headers.vary).toBe('Origin');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
  });

  it('grants error responses too, so the web app can read the error code', async () => {
    const bad = await call('GET', '/v1/tokens?chain=evm:5', { origin: WEB });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['access-control-allow-origin']).toBe(WEB);
    const missing = await call('GET', '/nope', { origin: WEB });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['access-control-allow-origin']).toBe(WEB);
    const post = await call('POST', '/v1/quotes', { origin: WEB }, undefined, { x: 1 });
    expect(post.statusCode).toBe(400);
    expect(post.headers['access-control-allow-origin']).toBe(WEB);
  });

  it('answers a preflight from an allowed origin with the fixed grant', async () => {
    for (const method of ['GET', 'POST']) {
      const res = await call('OPTIONS', '/v1/quotes', {
        origin: WEB,
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type',
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(res.headers['access-control-allow-origin']).toBe(WEB);
      expect(res.headers['access-control-allow-methods']).toBe(CORS_ALLOWED_METHODS);
      expect(res.headers['access-control-allow-headers']).toBe(CORS_ALLOWED_HEADERS);
      expect(res.headers['access-control-max-age']).toBe(String(CORS_MAX_AGE_SECONDS));
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers.vary).toBe('Origin');
    }
    expect(CORS_ALLOWED_METHODS).toBe('GET, POST, OPTIONS');
    expect(CORS_ALLOWED_HEADERS).toBe('content-type');
  });

  it('answers other preflights with 204 and no CORS headers', async () => {
    const cases: Record<string, string>[] = [
      { origin: EVIL, 'access-control-request-method': 'POST' },
      { origin: WEB, 'access-control-request-method': 'DELETE' },
      { origin: WEB, 'access-control-request-method': 'PUT' },
      { origin: WEB, 'access-control-request-method': 'post' },
      { origin: WEB },
      { 'access-control-request-method': 'GET' },
    ];
    for (const headers of cases) {
      const res = await call('OPTIONS', '/v1/tokens', headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(204);
      expect(corsHeaders(res.headers), JSON.stringify(headers)).toEqual([]);
    }
  });

  it('never sends a wildcard, whatever the request', async () => {
    for (const origin of ['*', WEB, EVIL]) {
      for (const method of ['GET', 'OPTIONS'] as const) {
        const res = await call(method, '/v1/chains', {
          origin,
          'access-control-request-method': 'GET',
        });
        expect(res.headers['access-control-allow-origin']).not.toBe('*');
        expect(res.headers['access-control-allow-headers']).not.toBe('*');
        expect(res.headers['access-control-allow-methods']).not.toBe('*');
      }
    }
  });

  it('allows no cross-origin access when WEB_ORIGINS is unset', async () => {
    const webOrigins = loadConfig({}).WEB_ORIGINS;
    expect(webOrigins).toEqual([]);
    const get = await call('GET', '/v1/chains', { origin: WEB }, webOrigins);
    expect(get.statusCode).toBe(200);
    expect(corsHeaders(get.headers)).toEqual([]);
    expect(get.headers.vary).toBeUndefined();
    const preflight = await call(
      'OPTIONS',
      '/v1/quotes',
      { origin: WEB, 'access-control-request-method': 'POST' },
      webOrigins,
    );
    expect(preflight.statusCode).toBe(404);
    expect(corsHeaders(preflight.headers)).toEqual([]);
  });

  it('appends Origin to an existing Vary header once, as a string or a list', async () => {
    const app = buildServer({ providers: [], webOrigins: [WEB] });
    app.get('/vary', async (_req, reply) => reply.header('vary', 'Accept-Encoding').send('x'));
    app.get('/vary-origin', async (_req, reply) => reply.header('vary', 'origin').send('x'));
    app.get('/vary-star', async (_req, reply) => reply.header('vary', '*').send('x'));
    app.get('/vary-list', async (_req, reply) =>
      reply.header('vary', ['Accept-Encoding', 'Accept-Language']).send('x'),
    );
    app.get('/vary-list-origin', async (_req, reply) =>
      reply.header('vary', ['Accept-Encoding', 'Origin']).send('x'),
    );
    expect((await app.inject({ url: '/vary', headers: { origin: WEB } })).headers.vary).toBe(
      'Accept-Encoding, Origin',
    );
    expect((await app.inject({ url: '/vary-origin' })).headers.vary).toBe('origin');
    expect((await app.inject({ url: '/vary-star' })).headers.vary).toBe('*');
    expect((await app.inject({ url: '/vary-list' })).headers.vary).toBe(
      'Accept-Encoding, Accept-Language, Origin',
    );
    expect((await app.inject({ url: '/vary-list-origin' })).headers.vary).toEqual([
      'Accept-Encoding',
      'Origin',
    ]);
  });
});

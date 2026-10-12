import type { FastifyInstance, FastifyReply } from 'fastify';

/** Methods and request headers a cross-origin caller may use. Nothing else is granted. */
export const CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';
export const CORS_ALLOWED_HEADERS = 'content-type';
const PREFLIGHT_METHODS: ReadonlySet<string> = new Set(['GET', 'POST']);
/** Seconds a browser may cache a preflight answer. */
export const CORS_MAX_AGE_SECONDS = 600;

function appendVary(reply: FastifyReply, field: string): void {
  const current = reply.getHeader('vary');
  const existing = typeof current === 'string' ? current : '';
  const fields = existing
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  if (fields.some((f) => f === '*' || f.toLowerCase() === field.toLowerCase())) return;
  reply.header('vary', [...fields, field].join(', '));
}

/**
 * Minimal explicit CORS (ADR 0006), instead of a plugin, so every granted header is visible here:
 *
 * - Only exact origins from WEB_ORIGINS get `Access-Control-Allow-Origin`, echoing that origin.
 *   Never `*`, never `Access-Control-Allow-Credentials`, no exposed headers.
 * - Other origins get no CORS headers at all; the request is still served (CORS is enforced by
 *   the browser, it is not access control), the browser just withholds the response.
 * - Preflight (`OPTIONS` with `Access-Control-Request-Method`) answers 204. An allowed origin
 *   asking for GET or POST gets its origin and the fixed method and header lists; anything
 *   else gets no CORS headers.
 * - `Vary: Origin` on every response, so a shared cache never serves one origin's grant to
 *   another (list responses are cacheable).
 *
 * With no origins configured nothing is registered: no cross-origin access, and `OPTIONS`
 * requests get the usual 404.
 */
export function registerCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  if (allowedOrigins.length === 0) return;
  const allowed: ReadonlySet<string> = new Set(allowedOrigins);
  const allowedOrigin = (origin: string | undefined): origin is string =>
    typeof origin === 'string' && allowed.has(origin);

  app.addHook('onSend', async (req, reply, payload) => {
    appendVary(reply, 'Origin');
    // Preflight answers set their own grant, or none.
    if (req.method !== 'OPTIONS' && allowedOrigin(req.headers.origin)) {
      reply.header('access-control-allow-origin', req.headers.origin);
    }
    return payload;
  });

  app.options('*', async (req, reply) => {
    const method = req.headers['access-control-request-method'];
    if (
      allowedOrigin(req.headers.origin) &&
      typeof method === 'string' &&
      PREFLIGHT_METHODS.has(method)
    ) {
      reply
        .header('access-control-allow-origin', req.headers.origin)
        .header('access-control-allow-methods', CORS_ALLOWED_METHODS)
        .header('access-control-allow-headers', CORS_ALLOWED_HEADERS)
        .header('access-control-max-age', String(CORS_MAX_AGE_SECONDS));
    }
    return reply.code(204).send();
  });
}

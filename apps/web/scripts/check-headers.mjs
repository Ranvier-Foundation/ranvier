/**
 * Header check against the standalone server (the artefact we deploy), for CI (ADR 0008).
 * Usage: pnpm --filter @ranvier/web check:headers   (needs `pnpm --filter @ranvier/web build`)
 *
 * Starts .next/standalone/apps/web/server.js twice: enforcing, then with CSP_REPORT_ONLY=1.
 * Checks, on `/` and on a 404: the CSP is present under the right header name only, carries a
 * 128-bit nonce that changes on every request and is on every <script>, has no `unsafe-*` and no
 * `'self'` for scripts, the page is `private, no-store`, and the static security headers are set.
 */
/* global process, console, fetch, setTimeout */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const SERVER = resolve(import.meta.dirname, '../.next/standalone/apps/web/server.js');
const ROUTES = [
  ['/', 200],
  ['/this-page-does-not-exist', 404],
];
const STATIC = [
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
];
const NONCE = /script-src 'nonce-([A-Za-z0-9+/]{22}==)' 'strict-dynamic'/;

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

function freePort() {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => done(port));
    });
  });
}

async function withServer(env, fn) {
  const port = await freePort();
  const server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env, PORT: String(port), HOSTNAME: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const end = Date.now() + 30_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`server.js exited with ${server.exitCode}`);
      try {
        await fetch(base);
        break;
      } catch {
        if (Date.now() > end) throw new Error(`server.js did not answer at ${base}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await fn(base);
  } finally {
    server.kill('SIGKILL');
  }
}

async function checkMode(base, reportOnly) {
  const name = reportOnly ? 'content-security-policy-report-only' : 'content-security-policy';
  const other = reportOnly ? 'content-security-policy' : 'content-security-policy-report-only';
  const label = reportOnly ? 'report-only' : 'enforce';
  for (const [route, status] of ROUTES) {
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(base + route);
      const html = await res.text();
      const where = `${label} ${route} #${i + 1}`;
      check(res.status === status, `${where}: status ${res.status}, expected ${status}`);
      const policy = res.headers.get(name) ?? '';
      console.log(`${where}: ${name}: ${policy}`);
      check(res.headers.get(other) === null, `${where}: unexpected ${other} header`);
      const nonce = NONCE.exec(policy)?.[1];
      check(nonce !== undefined, `${where}: no nonce with 'strict-dynamic' in ${name}`);
      nonces.push(nonce);
      check(!/unsafe-/.test(policy), `${where}: policy contains unsafe-*`);
      check(!/script-src[^;]*'self'/.test(policy), `${where}: script-src allows 'self'`);
      check(/default-src 'none'/.test(policy), `${where}: default-src is not 'none'`);
      const scripts = html.match(/<script\b[^>]*>/g) ?? [];
      check(scripts.length > 0, `${where}: no <script> tags`);
      check(
        scripts.every((tag) => tag.includes(` nonce="${nonce}"`)),
        `${where}: a <script> lacks this response's nonce`,
      );
      const cache = res.headers.get('cache-control') ?? '';
      check(/private/.test(cache) && /no-store/.test(cache), `${where}: Cache-Control ${cache}`);
      for (const h of STATIC) check(res.headers.get(h), `${where}: missing ${h}`);
    }
    check(nonces[0] !== nonces[1], `${label} ${route}: nonce did not change between requests`);
  }
}

if (!existsSync(SERVER)) {
  console.error(`${SERVER} not found: run the web build first`);
  process.exit(1);
}
await withServer({ CSP_REPORT_ONLY: '' }, (base) => checkMode(base, false));
await withServer({ CSP_REPORT_ONLY: '1' }, (base) => checkMode(base, true));
if (failures.length > 0) {
  console.error(`\nheader check FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nheader check passed (enforce and report-only)');

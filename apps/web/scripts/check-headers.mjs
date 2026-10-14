/**
 * Header check against the standalone server (the artefact we deploy), for CI (ADR 0008).
 * Usage: pnpm --filter @ranvier/web check:headers   (needs `pnpm --filter @ranvier/web build`)
 *
 * Starts .next/standalone/apps/web/server.js three times:
 * 1. enforcing, with hostile runtime values for NEXT_PUBLIC_API_URL and RANVIER_BUILD_API_ORIGIN
 *    (the API origin is fixed at build, so neither may change `connect-src` or break a request);
 * 2. CSP_REPORT_ONLY=1 with RANVIER_ENV=staging: Report-Only, and a startup warning;
 * 3. CSP_REPORT_ONLY=1 with RANVIER_ENV=production: ignored (still enforced), and a warning.
 * On every page and probe path (sent byte for byte), twice: the policy under the right header
 * name only, a 128-bit nonce that changes per request and is on every <script>, no `unsafe-*`,
 * no `'self'` for scripts, `private, no-store`, and the static security headers. Also HEAD and
 * POST on `/`, /_global-error as a 404, and build-asset misses as plain-text 404s without CSP.
 */
/* global process, console, setTimeout */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { PROBE_PATHS, STATIC_MISS_PATHS } from '../tests/e2e/routes.ts';

const SERVER = resolve(import.meta.dirname, '../.next/standalone/apps/web/server.js');
const PAGES = [
  ['/', 200],
  ['/this-page-does-not-exist', 404],
  ...PROBE_PATHS.map((p) => [p, p === '/%2e%2e/' ? 200 : 404]),
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
const HOSTILE = {
  NEXT_PUBLIC_API_URL: "https://x'y",
  RANVIER_BUILD_API_ORIGIN: 'https://evil.example',
};

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

/** One request, path sent exactly as written (fetch would normalise `%2e%2e`). */
function raw(port, method, path) {
  return new Promise((done, fail) => {
    const req = request({ hostname: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

async function withServer(env, fn) {
  const port = await freePort();
  const server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CSP_REPORT_ONLY: '',
      RANVIER_ENV: '',
      ...env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (c) => (output += c));
  server.stderr.on('data', (c) => (output += c));
  try {
    const end = Date.now() + 30_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`server.js exited with ${server.exitCode}`);
      try {
        await raw(port, 'GET', '/');
        break;
      } catch {
        if (Date.now() > end) throw new Error(`server.js did not answer on port ${port}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await fn(port);
    return output;
  } finally {
    server.kill('SIGKILL');
  }
}

async function checkMode(port, label, reportOnly) {
  const name = reportOnly ? 'content-security-policy-report-only' : 'content-security-policy';
  const other = reportOnly ? 'content-security-policy' : 'content-security-policy-report-only';
  for (const [path, status] of PAGES) {
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const res = await raw(port, 'GET', path);
      const where = `${label} GET ${path} #${i + 1}`;
      check(res.status === status, `${where}: status ${res.status}, expected ${status}`);
      check(/text\/html/.test(res.headers['content-type'] ?? ''), `${where}: not HTML`);
      const policy = res.headers[name] ?? '';
      if (i === 0) console.log(`${where}: ${name}: ${policy}`);
      check(res.headers[other] === undefined, `${where}: unexpected ${other} header`);
      const nonce = NONCE.exec(policy)?.[1];
      check(nonce !== undefined, `${where}: no nonce with 'strict-dynamic' in ${name}`);
      nonces.push(nonce);
      check(!/unsafe-/.test(policy), `${where}: policy contains unsafe-*`);
      check(!/script-src[^;]*'self'/.test(policy), `${where}: script-src allows 'self'`);
      check(/default-src 'none'/.test(policy), `${where}: default-src is not 'none'`);
      check(!/evil\.example|x'y/.test(policy), `${where}: runtime env changed connect-src`);
      const scripts = res.body.match(/<script\b[^>]*>/g) ?? [];
      check(scripts.length > 0, `${where}: no <script> tags`);
      check(
        scripts.every((tag) => tag.includes(` nonce="${nonce}"`)),
        `${where}: a <script> lacks this response's nonce`,
      );
      const cache = res.headers['cache-control'] ?? '';
      check(/private/.test(cache) && /no-store/.test(cache), `${where}: Cache-Control ${cache}`);
      for (const h of STATIC) check(res.headers[h], `${where}: missing ${h}`);
    }
    check(nonces[0] !== nonces[1], `${label} ${path}: nonce did not change between requests`);
  }
  for (const method of ['HEAD', 'POST']) {
    const res = await raw(port, method, '/');
    const where = `${label} ${method} /`;
    check(res.status === 200, `${where}: status ${res.status}`);
    check(NONCE.test(res.headers[name] ?? ''), `${where}: no policy`);
    check(/no-store/.test(res.headers['cache-control'] ?? ''), `${where}: not no-store`);
  }
  const globalError = await raw(port, 'GET', '/_global-error');
  check(
    !/s-maxage/.test(globalError.headers['cache-control'] ?? ''),
    `${label} /_global-error is cacheable`,
  );
  for (const path of STATIC_MISS_PATHS) {
    const res = await raw(port, 'GET', path);
    const where = `${label} GET ${path}`;
    check(res.status === 404, `${where}: status ${res.status}`);
    check(/text\/plain/.test(res.headers['content-type'] ?? ''), `${where}: not text/plain`);
    check(!/<html|<script/i.test(res.body), `${where}: body looks like HTML`);
  }
}

if (!existsSync(SERVER)) {
  console.error(`${SERVER} not found: run the web build first`);
  process.exit(1);
}
const quiet = await withServer(HOSTILE, (port) => checkMode(port, 'enforce', false));
check(!/\[security\]/.test(quiet), 'enforce: unexpected [security] warning at startup');
const staging = await withServer({ CSP_REPORT_ONLY: '1', RANVIER_ENV: 'staging' }, (port) =>
  checkMode(port, 'report-only(staging)', true),
);
check(/CSP IS NOT ENFORCED/.test(staging), 'report-only(staging): no startup warning');
const stray = await withServer({ CSP_REPORT_ONLY: '1', RANVIER_ENV: 'production' }, (port) =>
  checkMode(port, 'stray-flag(production)', false),
);
check(/CSP_REPORT_ONLY=1 IGNORED/.test(stray), 'stray-flag(production): no startup warning');
if (failures.length > 0) {
  console.error(`\nheader check FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nheader check passed (enforce, report-only on staging, stray flag ignored)');

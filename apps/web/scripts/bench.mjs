/**
 * Small HTTP load test for the web app (docs/runbooks/web-deployment-headers.md, rate limiting).
 * Usage: node apps/web/scripts/bench.mjs <url> [requests=2000] [concurrency=20] [--allow-host <host>]
 * Prints latency percentiles, throughput and a count per status code (429s show the limiter
 * working). No dependencies. Only localhost, 127.0.0.1 and [::1] are allowed unless the target
 * host is named explicitly with --allow-host (it must equal the URL's host): load-test only hosts
 * you operate.
 */
/* global process, console, fetch, performance, URL */
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const args = process.argv.slice(2);
const allowed = [];
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--allow-host') allowed.push((args[++i] ?? '').toLowerCase());
  else positional.push(args[i]);
}
const [url, n = '2000', c = '20'] = positional;
if (!url) {
  console.error('usage: node bench.mjs <url> [requests] [concurrency] [--allow-host <host>]');
  process.exit(2);
}
let host;
try {
  host = new URL(url).hostname.toLowerCase();
} catch {
  console.error(`not a URL: ${url}`);
  process.exit(2);
}
if (!LOCAL.has(host) && !allowed.includes(host)) {
  console.error(
    `refusing to load-test ${host}: only localhost is allowed by default. ` +
      `Pass --allow-host ${host} if you operate it.`,
  );
  process.exit(2);
}
const total = Number(n);
const concurrency = Number(c);
const times = [];
const statuses = {};
let started = 0;

async function worker() {
  while (started < total) {
    started++;
    const t = performance.now();
    try {
      const res = await fetch(url, { redirect: 'manual' });
      await res.arrayBuffer();
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    } catch (err) {
      const key = `error ${err instanceof Error ? err.message : String(err)}`;
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
    times.push(performance.now() - t);
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const wall = performance.now() - t0;
times.sort((a, b) => a - b);
const q = (p) => times[Math.floor(p * (times.length - 1))].toFixed(1);
console.log(
  JSON.stringify({
    url,
    requests: total,
    concurrency,
    p50_ms: q(0.5),
    p95_ms: q(0.95),
    p99_ms: q(0.99),
    req_per_s: Math.round((total / wall) * 1000),
    statuses,
  }),
);

/**
 * Small HTTP load test for the web app (docs/runbooks/web-deployment-headers.md, rate limiting).
 * Usage: node apps/web/scripts/bench.mjs <url> [requests=2000] [concurrency=20]
 * Prints latency percentiles, throughput and a count per status code (429s show the limiter
 * working). No dependencies. Point it only at hosts you operate.
 */
/* global process, console, fetch, performance */
const [url, n = '2000', c = '20'] = process.argv.slice(2);
if (!url) {
  console.error('usage: node bench.mjs <url> [requests] [concurrency]');
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

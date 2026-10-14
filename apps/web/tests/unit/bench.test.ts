import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BENCH = fileURLToPath(new URL('../../scripts/bench.mjs', import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [BENCH, ...args], { encoding: 'utf8', timeout: 20_000 });

describe('scripts/bench.mjs host guard', () => {
  it('refuses a non-local host without --allow-host, before sending anything', () => {
    for (const url of [
      'https://example.com/',
      'http://10.0.0.1:3000/',
      'https://LOCALHOST.evil/',
    ]) {
      const r = run(url, '1', '1');
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/refusing to load-test .*--allow-host/);
      expect(r.stdout).toBe('');
    }
  });

  it('refuses when --allow-host names a different host', () => {
    const r = run('https://example.com/', '1', '1', '--allow-host', 'staging.example.com');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing to load-test example\.com/);
  });

  it('runs against loopback (nothing listening: counted as errors, exit 0)', () => {
    for (const url of ['http://127.0.0.1:9/', 'http://localhost:9/', 'http://[::1]:9/']) {
      const r = run(url, '2', '1');
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout) as { requests: number; statuses: Record<string, number> };
      expect(out.requests).toBe(2);
      expect(Object.values(out.statuses).reduce((a, b) => a + b, 0)).toBe(2);
    }
  });

  it('rejects a missing or malformed URL', () => {
    expect(run().status).toBe(2);
    expect(run('not a url').status).toBe(2);
  });
});

/**
 * ADR 0013, section 2 (PR 3): the API's real production build holds nothing of the local chain.
 * Builds with the API's own `tsconfig.build.json` into a scratch directory on every run (source
 * analysis alone is not trusted). The web half needs `next build` and runs as
 * `pnpm guard:local-chain` (build-output.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_DEV_CONTRACTS } from '@ranvier/chains/local-dev';
import { localChainNeedles, REPO, scanOutput } from './build-output.js';

const scratch = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

describe('scanOutput finds the local chain in any spelling', () => {
  let dir = '';
  beforeAll(() => {
    dir = scratch('ranvier-scan-');
    mkdirSync(join(dir, 'chunks'));
    mkdirSync(join(dir, 'cache'));
    writeFileSync(join(dir, 'clean.js'), 'export const CHAINS = ["evm:1"];');
    writeFileSync(join(dir, 'chunks/a.js'), `x="${getAddress(LOCAL_DEV_CONTRACTS.feeWrapper)}"`);
    writeFileSync(join(dir, 'chunks/b.js'), 'n="LOCAL TEST CHAIN (not a real network)"');
    writeFileSync(join(dir, 'chunks/c.js'), "import('@ranvier/chains/local-dev')");
    writeFileSync(join(dir, 'chunks/d.js'), "k='evm:31337'");
    writeFileSync(join(dir, 'cache/e.js'), 'Local test chain');
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('hits every planted file, and skips skipped directories', () => {
    const { files, hits } = scanOutput(dir, localChainNeedles(), new Set(['cache']));
    expect(files).toBe(5);
    expect([...new Set(hits.map((h) => h.file.slice(dir.length + 1)))].sort()).toEqual([
      'chunks/a.js',
      'chunks/b.js',
      'chunks/c.js',
      'chunks/d.js',
    ]);
  });

  it('refuses a missing directory', () => {
    expect(() => scanOutput(join(dir, 'nope'))).toThrow('does not exist');
  });
});

describe('the API production build (tsconfig.build.json, built now)', { timeout: 60_000 }, () => {
  let out = '';
  beforeAll(() => {
    out = scratch('ranvier-api-dist-');
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', out], {
      cwd: join(REPO, 'apps/api'),
      stdio: 'pipe',
    });
  }, 180_000);
  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it('holds no local-chain name, key, address, subpath or harness path', () => {
    const { files, hits } = scanOutput(out);
    expect(files).toBeGreaterThan(20);
    expect(hits).toEqual([]);
  });

  it('control: main.js was built', () => {
    const { files } = scanOutput(out, ['buildServer']);
    expect(files).toBeGreaterThan(0);
    expect(scanOutput(out, ['buildServer']).hits.map((h) => h.file)).toContain(
      join(out, 'main.js'),
    );
  });
});

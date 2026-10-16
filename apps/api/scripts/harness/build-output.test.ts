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
import {
  localChainNeedles,
  productionSourceFiles,
  REPO,
  scanOutput,
  scanSources,
} from './build-output.js';
import { localDevAddresses } from '@ranvier/chains/local-dev';

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

describe('P7: production sources hold no harness literal', () => {
  it('the real repo: every production source directory is clean', () => {
    const files = productionSourceFiles(REPO).map((f) => f.slice(REPO.length));
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/api/src/main.ts',
        'apps/api/src/kms-smoke.ts',
        'apps/workers/src/main.ts',
        'apps/web/next.config.ts',
        'packages/fees/src/schedule.ts',
        'packages/chains/src/registry.ts',
        'contracts/src/FeeWrapper.sol',
        'contracts/script/Deploy.s.sol',
      ]),
    );
    expect(files).not.toContain('packages/chains/src/local-dev.ts');
    expect(scanSources(REPO).hits).toEqual([]);
  });

  describe('planted in a scratch repo', () => {
    let root = '';
    const write = (path: string, text: string): void => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    beforeAll(() => {
      root = scratch('ranvier-src-scan-');
      write('apps/api/src/main.ts', 'export {};\n');
      write(
        'packages/chains/src/local-dev.ts',
        `export const A = '${localDevAddresses()[0] ?? ''}';\n`,
      );
      write(
        'packages/chains/src/local-dev.test.ts',
        "import { LOCAL_DEV_CHAIN } from './local-dev.js';\n",
      );
      write('apps/api/src/harness/main.ts', "import '@ranvier/chains/local-dev';\n");
      write('docs/x.md', 'scripts/harness\n');
    });
    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('local-dev itself, its test, src/harness and docs are not scanned', () => {
      expect(scanSources(root)).toEqual({ files: 1, hits: [] });
    });

    it.each([
      [
        'apps/api/src/routers.ts',
        `export const R = '${getAddress(LOCAL_DEV_CONTRACTS.allowanceHolder)}';`,
      ],
      ['apps/api/src/lower.ts', `export const R = '${LOCAL_DEV_CONTRACTS.feeWrapper.slice(2)}';`],
      ['apps/workers/src/x.ts', "const p = '../../api/scripts/harness/pinned.js';"],
      ['apps/web/src/lib/x.mjs', 'export const N = "LOCAL_DEV_CHAIN";'],
      ['packages/fees/src/x.ts', '// see ranvier.harness.hUSDC'],
      ['contracts/script/X.s.sol', '// contracts/test/harness/HarnessConfig.sol'],
      ['apps/web/public/x.json', '{"a":"chains/local-dev"}'],
    ])('%s', (file, text) => {
      write(file, text);
      try {
        expect(scanSources(root).hits.map((h) => h.file.slice(root.length + 1))).toEqual([file]);
      } finally {
        rmSync(join(root, file));
      }
    });
  });
});

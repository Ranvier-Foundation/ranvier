/**
 * ADR 0013, section 2 (PR 3): the production API entry (`src/main.ts` and everything it reaches),
 * every production web module (everything `apps/web/src` reaches, plus `next.config.ts`) and the
 * `@ranvier/chains` index reach neither `@ranvier/chains/local-dev` nor any harness code
 * (`apps/api/scripts/`, `apps/api/src/harness/`, `contracts/test/harness/`).
 *
 * Source analysis only; `build-output.test.ts` and `pnpm guard:local-chain` check the real
 * build output as well.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  harnessReached,
  importGraph,
  moduleRefs,
  productionFiles,
  productionRoots,
} from './import-graph.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const at = (rel: string): string => join(REPO, rel);
const rel = (files: Iterable<string>): string[] => [...files].map((f) => relative(REPO, f));

describe('moduleRefs sees every module reference form', () => {
  it.each([
    ["import { a } from 'x';", 'import'],
    ["import type { A } from 'x';", 'import'],
    ["import 'x';", 'import'],
    ["export * from 'x';", 'export-from'],
    ["export * as ns from 'x';", 'export-from'],
    ["export { a } from 'x';", 'export-from'],
    ["export type { A } from 'x';", 'export-from'],
    ["import a = require('x');", 'import-equals'],
    ["const m = await import('x');", 'dynamic-import'],
    ['const m = await import(`x`);', 'dynamic-import'],
    ["const m = require('x');", 'require'],
    ["const p = require.resolve('x');", 'resolve'],
    ["const p = import.meta.resolve('x');", 'resolve'],
    ["type T = import('x').A;", 'import-type'],
    ["function f() { return () => import('x'); }", 'dynamic-import'],
    ["const u = new URL('x', import.meta.url);", 'new-url'],
    ["const w = new Worker(new URL('x', import.meta.url));", 'new-url'],
    ["const w = new SharedWorker(new URL('x', import.meta.url), { type: 'module' });", 'new-url'],
    ["const w = new Worker('x');", 'worker'],
    ["const w = new SharedWorker('x');", 'shared-worker'],
  ])('%s', (code, form) => {
    expect(moduleRefs('f.ts', code)).toEqual({ refs: [{ specifier: 'x', form }], problems: [] });
  });

  it('reports a dynamic import or require it cannot follow', () => {
    const { problems } = moduleRefs(
      'f.ts',
      "const n = 'x';\nawait import(n);\nrequire(`${n}`);\nimport.meta.resolve(n);",
    );
    expect(problems).toEqual([
      'f.ts:2: dynamic-import with a non-literal argument',
      'f.ts:3: require with a non-literal argument',
      'f.ts:4: resolve with a non-literal argument',
    ]);
  });

  it('reports a URL or worker it cannot follow (P8)', () => {
    const { refs, problems } = moduleRefs(
      'f.ts',
      "const n = 'x';\nnew URL(n, import.meta.url);\nnew Worker(n);\nnew URL('https://a.example/x');",
    );
    expect(refs).toEqual([]);
    expect(problems).toEqual([
      'f.ts:2: new-url with a non-literal argument',
      'f.ts:3: worker with a non-literal argument',
    ]);
  });

  it.each(['f.js', 'f.mjs', 'f.cjs', 'f.jsx'])('parses JavaScript too (P1/P2): %s', (file) => {
    const code = "import a from 'x';\nconst b = require('y');\nexport * from 'z';";
    expect(moduleRefs(file, code).refs.map((r) => r.specifier)).toEqual(['x', 'y', 'z']);
  });

  it('reads TSX', () => {
    const code = "import { A } from './a';\nexport const B = () => <A />;";
    expect(moduleRefs('f.tsx', code).refs).toEqual([{ specifier: './a', form: 'import' }]);
  });
});

describe(
  'importGraph on a scratch workspace catches local-dev through every form',
  { timeout: 60_000 },
  () => {
    let root = '';
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'ranvier-graph-'));
      write(
        'packages/chains/package.json',
        JSON.stringify({
          name: '@ranvier/chains',
          exports: {
            '.': { default: './dist/index.js' },
            './local-dev': { default: './dist/local-dev.js' },
          },
        }),
      );
      write('packages/chains/src/index.ts', "export * from './registry.js';\n");
      write('packages/chains/src/registry.ts', 'export const CHAINS = [];\n');
      write('packages/chains/src/local-dev.ts', 'export const LOCAL_DEV_CHAIN = {};\n');
      write('apps/web/package.json', JSON.stringify({ name: '@ranvier/web' }));
      write('apps/web/src/lib/x.ts', 'export const x = 1;\n');
      write('apps/api/scripts/harness/pinned.ts', 'export const P = 1;\n');
      write('contracts/test/harness/note.ts', 'export const N = 1;\n');
    });

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    const reach = (code: string, file = 'apps/api/src/main.ts'): string[] => {
      write(file, code);
      const graph = importGraph(root, [join(root, file)]);
      expect(graph.problems).toEqual([]);
      return harnessReached(root, graph);
    };

    it('a clean entry reaches nothing', () => {
      expect(reach("import { CHAINS } from '@ranvier/chains';\nexport { CHAINS };")).toEqual([]);
    });

    it.each([
      "import { LOCAL_DEV_CHAIN } from '@ranvier/chains/local-dev';",
      "import type { X } from '@ranvier/chains/local-dev';",
      "export * from '@ranvier/chains/local-dev';",
      "export { LOCAL_DEV_CHAIN } from '@ranvier/chains/local-dev';",
      "const m = await import('@ranvier/chains/local-dev');",
      "const m = require('@ranvier/chains/local-dev');",
      "import m = require('@ranvier/chains/local-dev');",
      "import { a } from './b.js';", // through a second module (b.ts below)
      "import '../../../packages/chains/src/local-dev.js';",
      "import { P } from '../scripts/harness/pinned.js';",
      "const p = await import('../scripts/harness/pinned.js');",
      "import '../../../contracts/test/harness/note.js';",
    ])('%s', (code) => {
      write('apps/api/src/b.ts', "export * from '@ranvier/chains/local-dev';\n");
      expect(reach(code)).not.toEqual([]);
    });

    it('through the package index re-exporting it', () => {
      write('packages/chains/src/index.ts', "export * from './local-dev.js';\n");
      try {
        expect(reach("import '@ranvier/chains';")).toEqual([
          'apps/api/src/main.ts -> packages/chains/src/index.ts -> packages/chains/src/local-dev.ts',
        ]);
      } finally {
        write('packages/chains/src/index.ts', "export * from './registry.js';\n");
      }
    });

    it("through the web's @/ alias", () => {
      write('apps/web/src/lib/x.ts', "export * from '@ranvier/chains/local-dev';\n");
      try {
        expect(reach("import { x } from '@/lib/x';", 'apps/web/src/page.tsx')).toHaveLength(1);
      } finally {
        write('apps/web/src/lib/x.ts', 'export const x = 1;\n');
      }
    });

    it('fails closed on what it cannot follow', () => {
      write('apps/api/src/main.ts', "const s = 'x';\nawait import(s);\nimport './missing.js';");
      const graph = importGraph(root, [join(root, 'apps/api/src/main.ts')]);
      expect(graph.problems).toHaveLength(2);
      write('apps/api/src/main.ts', "import '@ranvier/chains/not-exported';");
      expect(importGraph(root, [join(root, 'apps/api/src/main.ts')]).problems).toHaveLength(1);
    });
  },
);

describe(
  'productionRoots covers every production source directory (P4, P5, P9)',
  { timeout: 60_000 },
  () => {
    let root = '';
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const reached = (): string[] => {
      const graph = importGraph(root, productionRoots(root));
      expect(graph.problems).toEqual([]);
      return harnessReached(root, graph);
    };

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'ranvier-roots-'));
      write(
        'packages/chains/package.json',
        JSON.stringify({
          name: '@ranvier/chains',
          exports: {
            '.': { default: './dist/index.js' },
            './local-dev': { default: './dist/local-dev.js' },
          },
        }),
      );
      write('packages/chains/src/index.ts', 'export const CHAINS = [];\n');
      write('packages/chains/src/local-dev.ts', 'export const LOCAL_DEV_CHAIN = {};\n');
      write('packages/chains/src/local-dev.test.ts', "import './local-dev.js';\n");
      write('packages/fees/package.json', JSON.stringify({ name: '@ranvier/fees' }));
      write('packages/fees/src/index.ts', 'export const FEE = 1;\n');
      write('apps/api/package.json', JSON.stringify({ name: '@ranvier/api' }));
      write('apps/api/src/main.ts', "import '@ranvier/chains';\n");
      write('apps/api/src/x.test.ts', "import '@ranvier/chains/local-dev';\n");
      write('apps/api/src/harness/main.ts', "import '@ranvier/chains/local-dev';\n");
      write('apps/workers/package.json', JSON.stringify({ name: '@ranvier/workers' }));
      write('apps/workers/src/main.ts', 'export {};\n');
      write('apps/web/package.json', JSON.stringify({ name: '@ranvier/web' }));
      write('apps/web/src/page.tsx', 'export const P = 1;\n');
    });
    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    it('a clean scratch repo reaches nothing (local-dev itself, tests and src/harness are not roots)', () => {
      const roots = rel2(root, productionRoots(root));
      expect(roots.sort()).toEqual([
        'apps/api/src/main.ts',
        'apps/web/src/page.tsx',
        'apps/workers/src/main.ts',
        'packages/chains/src/index.ts',
        'packages/fees/src/index.ts',
      ]);
      expect(reached()).toEqual([]);
    });

    it('production code importing apps/api/src/harness/ is caught by path alone (PR 4b)', () => {
      // The harness file itself imports nothing from local-dev: only the forbidden path catches it.
      write('apps/api/src/harness/plain.ts', 'export const S = 1;\n');
      write(
        'apps/api/src/uses-harness.ts',
        "import { S } from './harness/plain.js';\nexport { S };\n",
      );
      try {
        expect(reached()).toEqual([
          'apps/api/src/uses-harness.ts -> apps/api/src/harness/plain.ts',
        ]);
      } finally {
        rmSync(join(root, 'apps/api/src/uses-harness.ts'));
        rmSync(join(root, 'apps/api/src/harness/plain.ts'));
      }
    });

    it.each([
      ['P4 workers', 'apps/workers/src/health.ts'],
      ['P5 an API entry other than main.ts (kms-smoke.ts)', 'apps/api/src/kms-smoke.ts'],
      ['an API test helper (src/testing/)', 'apps/api/src/testing/helper.ts'],
      ['P9 packages/fees re-exporting it', 'packages/fees/src/schedule.ts'],
      ['a web module', 'apps/web/src/lib/z.mjs'],
    ])('%s', (_name, file) => {
      write(file, "export * from '@ranvier/chains/local-dev';\n");
      try {
        expect(reached()).not.toEqual([]);
      } finally {
        rmSync(join(root, file));
      }
    });
  },
);

const rel2 = (base: string, files: Iterable<string>): string[] =>
  [...files].map((f) => relative(base, f));

describe('production code reaches no harness code (the real repo)', { timeout: 120_000 }, () => {
  it('the API entry src/main.ts', () => {
    const graph = importGraph(REPO, [at('apps/api/src/main.ts')]);
    expect(graph.problems).toEqual([]);
    expect(harnessReached(REPO, graph)).toEqual([]);
    // The analysis really walked the API and its workspace packages.
    expect(rel(graph.files)).toEqual(
      expect.arrayContaining([
        'apps/api/src/http/server.ts',
        'apps/api/src/adapters/signers/local-key.ts',
        'packages/chains/src/index.ts',
        'packages/chains/src/registry.ts',
        'packages/fees/src/index.ts',
      ]),
    );
  });

  it('every production web module under apps/web/src, and next.config.ts', () => {
    const roots = [...productionFiles(at('apps/web/src')), at('apps/web/next.config.ts')];
    expect(roots.length).toBeGreaterThan(20);
    const graph = importGraph(REPO, roots);
    expect(graph.problems).toEqual([]);
    expect(harnessReached(REPO, graph)).toEqual([]);
    expect(rel(graph.files)).toEqual(
      expect.arrayContaining(['packages/chains/src/index.ts', 'packages/fees/src/index.ts']),
    );
  });

  it('every production source file: apps/api/src, apps/workers/src, apps/web/src, packages/*/src', () => {
    const roots = productionRoots(REPO);
    expect(rel(roots)).toEqual(
      expect.arrayContaining([
        'apps/api/src/main.ts',
        'apps/api/src/kms-smoke.ts',
        'apps/workers/src/main.ts',
        'apps/web/next.config.ts',
        'packages/fees/src/schedule.ts',
        'packages/chains/src/verify-cli.ts',
      ]),
    );
    expect(rel(roots)).not.toContain('packages/chains/src/local-dev.ts');
    expect(rel(roots).filter((f) => /\.test\./.test(f))).toEqual([]);
    const graph = importGraph(REPO, roots);
    expect(graph.problems).toEqual([]);
    expect(harnessReached(REPO, graph)).toEqual([]);
  });

  it('the @ranvier/chains index', () => {
    const graph = importGraph(REPO, [at('packages/chains/src/index.ts')]);
    expect(graph.problems).toEqual([]);
    expect(harnessReached(REPO, graph)).toEqual([]);
    expect(rel(graph.files)).toContain('packages/chains/src/tokens.ts');
  });

  it('control: the harness API entry reaches local-dev and src/harness (the guard would see it)', () => {
    const graph = importGraph(REPO, [at('apps/api/src/harness/main.ts')]);
    expect(graph.problems).toEqual([]);
    expect(rel(graph.files)).toEqual(
      expect.arrayContaining([
        'packages/chains/src/local-dev.ts',
        'apps/api/src/harness/start.ts',
        'apps/api/src/http/server.ts',
      ]),
    );
    expect(harnessReached(REPO, graph).length).toBeGreaterThan(0);
  });

  it('no production root is under apps/api/src/harness/, and none reaches it', () => {
    const roots = rel(productionRoots(REPO));
    expect(roots.filter((f) => f.startsWith('apps/api/src/harness/'))).toEqual([]);
    const graph = importGraph(REPO, productionRoots(REPO));
    expect(rel(graph.files).filter((f) => f.startsWith('apps/api/src/harness/'))).toEqual([]);
  });

  it('control: the harness smoke does reach local-dev (the analysis is not blind)', () => {
    const graph = importGraph(REPO, [at('apps/api/scripts/harness/smoke.ts')]);
    expect(graph.problems).toEqual([]);
    expect(rel(graph.files)).toContain('packages/chains/src/local-dev.ts');
  });
});

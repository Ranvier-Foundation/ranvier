/**
 * The harness never reaches production: nothing under src/ imports it, the build config compiles
 * src/ only, and the default test run leaves the anvil smoke out.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { moduleRefs } from './import-graph.js';

const API = fileURLToPath(new URL('../../', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

/** A reference to scripts/: static `from`, `import()`, `require()`, `require.resolve()`. */
const SCRIPTS_TEXT =
  /(?:from\s*|import\s*\(\s*|require(?:\.resolve)?\s*\(\s*)['"`][^'"`]*scripts\//;

/** Why `text` references scripts/ (empty when it does not). */
function scriptsRefs(file: string, text: string): string[] {
  const { refs, problems } = moduleRefs(file, text);
  return [
    ...refs
      .filter((r) => /(?:^|\/)scripts\//.test(r.specifier))
      .map((r) => `${r.form} ${r.specifier}`),
    // A dynamic import that cannot be followed could reach scripts/: refused as well.
    ...problems,
    ...(SCRIPTS_TEXT.test(text) ? ['text'] : []),
  ];
}

describe('harness isolation', () => {
  it('no module under src/ imports scripts/ (static, dynamic import(), require())', () => {
    const offenders = files(join(API, 'src')).flatMap((f) =>
      scriptsRefs(f, readFileSync(f, 'utf8')).map((why) => `${f}: ${why}`),
    );
    expect(offenders).toEqual([]);
  }, 60_000); // parses every src/ file; slow when turbo runs every package's tests at once

  it.each([
    "import { x } from '../scripts/harness/pinned.js';",
    "export * from '../../scripts/harness/smoke.js';",
    "const m = await import('../scripts/harness/smoke.js');",
    'const m = await import(`../scripts/harness/smoke.js`);',
    "const m = require('../scripts/kms-smoke.js');",
    "const p = require.resolve('../scripts/harness/anvil.js');",
    "import m = require('../scripts/harness/anvil.js');",
    "const s = '../scripts/x.js'; await import(s);",
  ])('the check catches: %s', (code) => {
    expect(scriptsRefs('f.ts', code)).not.toEqual([]);
  });

  it('the check passes clean code', () => {
    expect(scriptsRefs('f.ts', "import { a } from './domain/scripts-free.js';")).toEqual([]);
  });

  it('the build compiles src/ only (rootDir src), so dist/ cannot contain scripts/', () => {
    const build = JSON.parse(readFileSync(join(API, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { rootDir: string };
      include: string[];
    };
    expect(build.compilerOptions.rootDir).toBe('src');
    expect(build.include).toEqual(['src']);
  });

  it('the default vitest run excludes the anvil smoke', () => {
    expect(readFileSync(join(API, 'vitest.config.ts'), 'utf8')).toContain('*.harness.test.ts');
  });
});

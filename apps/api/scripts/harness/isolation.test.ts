/**
 * The harness never reaches production: nothing under src/ imports it, the build config compiles
 * src/ only, and the default test run leaves the anvil smoke out.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API = fileURLToPath(new URL('../../', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('harness isolation', () => {
  it('no module under src/ imports scripts/', () => {
    const offenders = files(join(API, 'src')).filter((f) =>
      /from\s+['"][^'"]*scripts\//.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
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

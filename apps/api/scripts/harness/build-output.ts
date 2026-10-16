/**
 * LOCAL TEST HARNESS GUARD (ADR 0013, section 2). Never imported by `src/`.
 *
 * Production build output must hold nothing of the local test chain: not its name, its key, any
 * harness address (any case), the `local-dev` subpath or a harness path. Source analysis
 * (`import-graph.ts`) is not trusted alone; this scans what the builds really emit.
 *
 * `pnpm guard:local-chain` builds the API (`tsc -p tsconfig.build.json`) and the web
 * (`next build`) for real (`turbo run build --force`), then scans `apps/api/dist` and `apps/web/.next` (without `cache/`,
 * which is not shipped, and `dev/`, the owner's `next dev` output). `--no-build` scans what is
 * there. Exits non-zero, naming file and needle, on any hit. `build-output.test.ts` runs the API
 * half on every `pnpm test`.
 */
import { CHAINS } from '@ranvier/chains';
import { LOCAL_DEV_CHAIN, localDevAddresses } from '@ranvier/chains/local-dev';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

/** What must never appear in production output. Matched case-insensitively. */
export function localChainNeedles(): string[] {
  return [
    'Local test chain',
    LOCAL_DEV_CHAIN.name,
    `"${LOCAL_DEV_CHAIN.key}"`,
    `'${LOCAL_DEV_CHAIN.key}'`,
    // Exact export names: Next ships an unrelated NEXT_PRIVATE_LOCAL_DEV_TEST_FILES_EXCLUDE.
    'LOCAL_DEV_CHAIN',
    'LOCAL_DEV_CONTRACTS',
    'chains/local-dev',
    'scripts/harness',
    'test/harness',
    'ranvier.harness',
    // Addresses without the 0x prefix, so any spelling or a split string literal still matches.
    ...localDevAddresses().map((a) => a.slice(2)),
  ];
}

export interface Hit {
  file: string;
  needle: string;
}

/** Every file under `dir`, skipping directory names in `skip` at any depth. */
function walk(dir: string, skip: ReadonlySet<string>): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return skip.has(e.name) ? [] : walk(path, skip);
    return e.isFile() ? [path] : [];
  });
}

/** Scans every file under `dir` (as text, any encoding) for every needle. */
export function scanOutput(
  dir: string,
  needles: readonly string[] = localChainNeedles(),
  skip: ReadonlySet<string> = new Set(),
): { files: number; hits: Hit[] } {
  if (!existsSync(dir)) throw new Error(`${dir} does not exist: build first`);
  const lowered = needles.map((n) => n.toLowerCase());
  const files = walk(dir, skip);
  const hits: Hit[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'latin1').toLowerCase();
    lowered.forEach((n, i) => {
      if (text.includes(n)) hits.push({ file, needle: needles[i] ?? n });
    });
  }
  return { files: files.length, hits };
}

/** The production output directories and what to skip in each. */
export interface Output {
  name: string;
  dir: string;
  skip: ReadonlySet<string>;
  /** Must be found, or the scan is blind (wrong directory, nothing bundled). */
  control: string;
}

/** The web bundles `@ranvier/chains`, so a registry address must show up in its output. */
const REGISTRY_CONTROL = CHAINS.find((c) => c.key === 'evm:8453')?.stablecoins.USDC ?? 'missing';

export const OUTPUTS: readonly Output[] = [
  { name: 'API dist', dir: join(REPO, 'apps/api/dist'), skip: new Set(), control: 'buildServer' },
  {
    name: 'web .next',
    dir: join(REPO, 'apps/web/.next'),
    skip: new Set(['cache', 'dev']),
    control: REGISTRY_CONTROL.slice(2),
  },
];

function main(argv: readonly string[]): number {
  if (!argv.includes('--no-build')) {
    // --force: a real build, never outputs replayed from turbo's cache.
    console.log('building @ranvier/api and @ranvier/web (and their workspace dependencies) ...');
    execFileSync(
      'pnpm',
      [
        'exec',
        'turbo',
        'run',
        'build',
        '--force',
        '--filter=@ranvier/api...',
        '--filter=@ranvier/web...',
      ],
      { cwd: REPO, stdio: 'inherit' },
    );
  }
  let failed = false;
  for (const out of OUTPUTS) {
    const { files, hits } = scanOutput(out.dir, localChainNeedles(), out.skip);
    if (files === 0 || scanOutput(out.dir, [out.control], out.skip).hits.length === 0) {
      console.error(`${out.name}: control "${out.control}" not found: the scan is blind`);
      failed = true;
      continue;
    }
    for (const h of hits)
      console.error(`${out.name}: ${relative(REPO, h.file)} holds "${h.needle}"`);
    console.log(`${out.name}: ${files} files scanned, ${hits.length} local-chain hits`);
    if (hits.length > 0) failed = true;
  }
  console.log(failed ? 'guard:local-chain FAILED' : 'guard:local-chain ok');
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}

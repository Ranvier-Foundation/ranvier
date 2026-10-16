/**
 * LOCAL TEST HARNESS GUARD (ADR 0013, section 2). Never imported by `src/`.
 *
 * Two text scans for the local test chain, next to the import graph (`import-graph.ts`):
 *
 * - Production SOURCES (`scanSources`): every file in the production source directories must hold
 *   no harness address, local-dev export name, local-dev subpath or harness path, so a literal
 *   pasted into production code is caught even though it is outside any import graph.
 * - Production BUILD OUTPUT (`scanOutput`): what the builds really emit must hold none of those,
 *   nor the chain's name or key.
 *
 * The import graph and the source scan are the primary guards. The text match is
 * case-insensitive on the bare 40-hex body, so the plain, 0x-prefixed and checksummed spellings
 * of an address all match; a value split mid-address, encoded (base64, hex of the bytes) or
 * computed at runtime would NOT match.
 *
 * `pnpm guard:local-chain` scans the sources, builds the API (`tsc -p tsconfig.build.json`) and
 * the web (`next build`) for real (`turbo run build --force`), then scans `apps/api/dist` and
 * `apps/web/.next` (without `cache/`, which is not shipped, and `dev/`, the owner's `next dev`
 * output). `--no-build` scans what is there. Exits non-zero, naming file and needle, on any hit.
 * `build-output.test.ts` runs the source scan and the API build half on every `pnpm test`.
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
    ...addressNeedles(),
  ];
}

/**
 * The 16 harness addresses as bare 40-hex bodies. Matched case-insensitively, so the plain,
 * 0x-prefixed and checksummed spellings match; a split or encoded value would not.
 */
function addressNeedles(): string[] {
  return localDevAddresses().map((a) => a.slice(2));
}

/** What must never appear in production source files (the name and key may, as prose). */
export function sourceNeedles(): string[] {
  return [
    'LOCAL_DEV_CHAIN',
    'LOCAL_DEV_CONTRACTS',
    'chains/local-dev',
    'scripts/harness',
    'test/harness',
    'ranvier.harness',
    ...addressNeedles(),
  ];
}

export interface Hit {
  file: string;
  needle: string;
}

/** Every file under `dir`, skipping directory names in `skip` at any depth and `exclude`d paths. */
function walk(
  dir: string,
  skip: ReadonlySet<string>,
  exclude: (path: string) => boolean = () => false,
): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (exclude(path)) return [];
    if (e.isDirectory()) return skip.has(e.name) ? [] : walk(path, skip, exclude);
    return e.isFile() ? [path] : [];
  });
}

function scanFiles(files: readonly string[], needles: readonly string[]): Hit[] {
  const lowered = needles.map((n) => n.toLowerCase());
  const hits: Hit[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'latin1').toLowerCase();
    lowered.forEach((n, i) => {
      if (text.includes(n)) hits.push({ file, needle: needles[i] ?? n });
    });
  }
  return hits;
}

/** Scans every file under `dir` (as text, any encoding) for every needle. */
export function scanOutput(
  dir: string,
  needles: readonly string[] = localChainNeedles(),
  skip: ReadonlySet<string> = new Set(),
): { files: number; hits: Hit[] } {
  if (!existsSync(dir)) throw new Error(`${dir} does not exist: build first`);
  const files = walk(dir, skip);
  return { files: files.length, hits: scanFiles(files, needles) };
}

/**
 * The production source directories (relative to the repo): every app's and package's `src/`, the
 * web's `next.config.ts` and `public/`, and the contracts' `src/` and `script/`. Left out: the
 * local-dev module and its test (they ARE the data), `apps/api/src/harness/` (the planned harness
 * entry, PR 4), and `node_modules`/`dist` (not sources). Docs and the harness and test
 * directories are outside these directories already.
 */
export function productionSourceFiles(repoRoot: string): string[] {
  const at = (rel: string): string => join(repoRoot, rel);
  const excluded = new Set([
    at('packages/chains/src/local-dev.ts'),
    at('packages/chains/src/local-dev.test.ts'),
    at('apps/api/src/harness'),
  ]);
  const dirs = [
    ...['apps', 'packages'].flatMap((group) =>
      existsSync(at(group))
        ? readdirSync(at(group), { withFileTypes: true })
            .filter((e) => e.isDirectory() && existsSync(at(`${group}/${e.name}/src`)))
            .map((e) => at(`${group}/${e.name}/src`))
        : [],
    ),
    at('apps/web/public'),
    at('contracts/src'),
    at('contracts/script'),
  ].filter((d) => existsSync(d));
  const files = [at('apps/web/next.config.ts')].filter((f) => existsSync(f));
  const skip = new Set(['node_modules', 'dist']);
  return [...files, ...dirs.flatMap((d) => walk(d, skip, (p) => excluded.has(p)))];
}

/** Scans every production source file for `sourceNeedles()`. */
export function scanSources(repoRoot: string = REPO): { files: number; hits: Hit[] } {
  const files = productionSourceFiles(repoRoot);
  return { files: files.length, hits: scanFiles(files, sourceNeedles()) };
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
  const sources = scanSources();
  for (const h of sources.hits) {
    console.error(`sources: ${relative(REPO, h.file)} holds "${h.needle}"`);
  }
  console.log(`sources: ${sources.files} files scanned, ${sources.hits.length} local-chain hits`);
  if (sources.files === 0 || sources.hits.length > 0) failed = true;
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

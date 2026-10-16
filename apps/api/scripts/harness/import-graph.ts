/**
 * LOCAL TEST HARNESS GUARD (ADR 0013, section 2). Never imported by `src/`.
 *
 * A static import graph over the repo's TypeScript and JavaScript sources, for the guard that
 * production code reaches neither `@ranvier/chains/local-dev` nor any harness code. It parses
 * every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` file it reaches and follows
 * every module reference form: `import` (value and type), `export * from`, `export { } from`,
 * `import x = require()`, `import('...')`, `require('...')`, `require.resolve('...')`,
 * `import.meta.resolve('...')`, `new URL('...', import.meta.url)` (which covers
 * `new Worker(new URL(...))` and `new SharedWorker(new URL(...))`) and `new Worker('...')`.
 *
 * Fail closed: a dynamic form whose argument is not a string literal cannot be followed, so it is a
 * problem, never skipped; so is a relative, `@/`, `#` or workspace specifier that does not resolve.
 *
 * Resolution: relative paths (with the `.js` -> `.ts`/`.tsx` mapping NodeNext uses), the web's
 * `@/` alias, `#` specifiers through the owning package's `imports` map (every target of a
 * conditional entry is followed), and `@ranvier/<pkg>[/<subpath>]` through that package's
 * `exports` map, from `./dist/<x>.js` back to `src/<x>.ts`. Any other bare specifier is an
 * external package: recorded, not followed (no workspace code lives in node_modules).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface ModuleRef {
  specifier: string;
  /** How it was written: `import`, `export-from`, `import-equals`, `dynamic-import`, ... */
  form: string;
}

export interface GraphResult {
  /** Every repo file reached (absolute paths), roots included. */
  files: Set<string>;
  /** Bare specifiers of external packages, as written. */
  externals: Set<string>;
  /** `file -> the file that first reached it`, to print a path from a root. */
  parent: Map<string, string>;
  /** Unfollowable references: non-literal dynamic imports, unresolved repo specifiers. */
  problems: string[];
}

/** Source files the graph parses (everything else it reaches is a leaf: CSS, JSON, images). */
export const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const isImportMetaUrl = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isPropertyAccessExpression(node) &&
  node.name.text === 'url' &&
  ts.isMetaProperty(node.expression) &&
  node.expression.name.text === 'meta';

/** Every module reference in one source file. */
export function moduleRefs(
  fileName: string,
  text: string,
): {
  refs: ModuleRef[];
  problems: string[];
} {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const refs: ModuleRef[] = [];
  const problems: string[] = [];
  const literal = (node: ts.Node | undefined): string | undefined =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const problem = (node: ts.Node, form: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    problems.push(`${fileName}:${line + 1}: ${form} with a non-literal argument`);
  };
  const dynamic = (call: ts.CallExpression | ts.NewExpression, form: string): void => {
    const arg = call.arguments?.[0];
    const spec = literal(arg);
    if (spec === undefined) problem(call, form);
    else refs.push({ specifier: spec, form });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      if (spec !== undefined) {
        refs.push({
          specifier: spec,
          form: ts.isImportDeclaration(node) ? 'import' : 'export-from',
        });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const spec = literal(node.moduleReference.expression);
      if (spec !== undefined) refs.push({ specifier: spec, form: 'import-equals' });
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      const spec = ts.isLiteralTypeNode(arg) ? literal(arg.literal) : undefined;
      if (spec !== undefined) refs.push({ specifier: spec, form: 'import-type' });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        dynamic(node, 'dynamic-import');
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        dynamic(node, 'require');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'resolve' &&
        ((ts.isIdentifier(callee.expression) && callee.expression.text === 'require') ||
          (ts.isMetaProperty(callee.expression) && callee.expression.name.text === 'meta'))
      ) {
        dynamic(node, 'resolve');
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const ctor = node.expression.text;
      const first = node.arguments?.[0];
      if (ctor === 'URL' && isImportMetaUrl(node.arguments?.[1])) {
        // A file next to this module: the bundler emits or loads it.
        dynamic(node, 'new-url');
      } else if (ctor === 'Worker' || ctor === 'SharedWorker') {
        // `new Worker(new URL(...))` is followed through the URL; a plain string is a path; any
        // other argument cannot be followed.
        const isUrl =
          first !== undefined &&
          ts.isNewExpression(first) &&
          ts.isIdentifier(first.expression) &&
          first.expression.text === 'URL';
        if (!isUrl) dynamic(node, ctor === 'Worker' ? 'worker' : 'shared-worker');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { refs, problems };
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

interface Workspace {
  repoRoot: string;
  /** `@ranvier/<name>` -> package directory. */
  packages: Map<string, string>;
  /** Directory whose files resolve `@/` (the web app's `src/`), keyed by the app directory. */
  aliasRoots: Map<string, string>;
}

function workspace(repoRoot: string): Workspace {
  const packages = new Map<string, string>();
  for (const group of ['packages', 'apps']) {
    const dir = join(repoRoot, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const pkgJson = join(dir, entry.name, 'package.json');
      if (!entry.isDirectory() || !isFile(pkgJson)) continue;
      const { name } = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string };
      if (name) packages.set(name, join(dir, entry.name));
    }
  }
  const web = join(repoRoot, 'apps/web');
  return { repoRoot, packages, aliasRoots: new Map([[web, join(web, 'src')]]) };
}

/** A path without extension, or with a `.js`-family one, to the source file it names. */
function resolveFile(base: string): string | undefined {
  const jsExt = /\.(?:js|jsx|mjs|cjs)$/;
  const candidates = jsExt.test(base)
    ? [
        base.replace(jsExt, (e) => (e === '.mjs' ? '.mts' : e === '.cjs' ? '.cts' : '.ts')),
        base.replace(/\.(?:js|jsx)$/, '.tsx'),
        base,
      ]
    : [
        base,
        ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((e) => base + e),
        ...['index.ts', 'index.tsx', 'index.js', 'index.mjs'].map((i) => join(base, i)),
      ];
  return candidates.find(isFile);
}

/** `@ranvier/<pkg>[/<sub>]` through the package's `exports`, mapped from dist to src. */
function resolveWorkspace(spec: string, ws: Workspace): string | undefined {
  const match = /^(@ranvier\/[^/]+)(\/.*)?$/.exec(spec);
  if (!match?.[1]) return undefined;
  const dir = ws.packages.get(match[1]);
  if (!dir) return undefined;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    exports?: Record<string, { default?: string } | string>;
  };
  const entry = pkg.exports?.[match[2] ? `.${match[2]}` : '.'];
  const target = typeof entry === 'string' ? entry : entry?.default;
  if (!target) return undefined;
  const src = target.replace(/^\.\/dist\//, './src/');
  return resolveFile(resolve(dir, src));
}

/** The nearest directory at or above `from`'s directory with a package.json, inside the repo. */
function owningPackage(from: string, ws: Workspace): string | undefined {
  for (let dir = dirname(from); dir.startsWith(ws.repoRoot); dir = dirname(dir)) {
    if (isFile(join(dir, 'package.json'))) return dir;
    if (dir === dirname(dir)) break;
  }
  return undefined;
}

/** Every string leaf of a conditional `imports` target (all conditions are followed). */
function targets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(targets);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(targets);
  return [];
}

/**
 * A `#...` specifier through the owning package's `imports` map (exact keys and `*` patterns).
 * Returns the target specifiers and the package directory they are relative to, or undefined.
 */
function resolveImportsAlias(
  spec: string,
  from: string,
  ws: Workspace,
): { pkgDir: string; specs: string[] } | undefined {
  const pkgDir = owningPackage(from, ws);
  if (!pkgDir) return undefined;
  const { imports } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    imports?: Record<string, unknown>;
  };
  if (!imports) return undefined;
  if (spec in imports) return { pkgDir, specs: targets(imports[spec]) };
  for (const [key, value] of Object.entries(imports)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= key.length - 1) {
      const middle = spec.slice(prefix.length, spec.length - suffix.length);
      return { pkgDir, specs: targets(value).map((t) => t.replaceAll('*', middle)) };
    }
  }
  return undefined;
}

export type Resolved =
  | { kind: 'file'; path: string }
  | { kind: 'external' }
  | { kind: 'unresolved' }
  | { kind: 'alias'; pkgDir: string; specs: string[] };

export function resolveSpecifier(spec: string, from: string, ws: Workspace): Resolved {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const path = resolveFile(resolve(dirname(from), spec));
    return path ? { kind: 'file', path } : { kind: 'unresolved' };
  }
  if (spec.startsWith('file:')) return { kind: 'unresolved' };
  if (spec.startsWith('#')) {
    const alias = resolveImportsAlias(spec, from, ws);
    return alias && alias.specs.length > 0 ? { kind: 'alias', ...alias } : { kind: 'unresolved' };
  }
  if (spec.startsWith('@/')) {
    for (const [app, root] of ws.aliasRoots) {
      if (from.startsWith(app + sep)) {
        const path = resolveFile(join(root, spec.slice(2)));
        return path ? { kind: 'file', path } : { kind: 'unresolved' };
      }
    }
    return { kind: 'unresolved' };
  }
  if (spec.startsWith('@ranvier/')) {
    const path = resolveWorkspace(spec, ws);
    return path ? { kind: 'file', path } : { kind: 'unresolved' };
  }
  return { kind: 'external' };
}

/** Everything reachable from `roots` (absolute paths) through module references. */
export function importGraph(repoRoot: string, roots: readonly string[]): GraphResult {
  const ws = workspace(resolve(repoRoot));
  const result: GraphResult = {
    files: new Set(),
    externals: new Set(),
    parent: new Map(),
    problems: [],
  };
  const queue = [...roots];
  for (const root of roots) {
    if (!isFile(root)) result.problems.push(`root ${root} does not exist`);
  }
  /** Follows one reference written in `from` (a file, or a package.json for `imports`). */
  const follow = (spec: string, form: string, from: string, origin: string, depth = 0): void => {
    const target = resolveSpecifier(spec, from, ws);
    if (target.kind === 'external') {
      result.externals.add(spec);
    } else if (target.kind === 'unresolved' || (target.kind === 'alias' && depth > 8)) {
      result.problems.push(`${relative(repoRoot, origin)}: cannot resolve ${form} '${spec}'`);
    } else if (target.kind === 'alias') {
      // Relative targets are relative to the package root; bare ones resolve as usual.
      const base = join(target.pkgDir, 'package.json');
      for (const t of target.specs)
        follow(t, `${form} via imports '${spec}'`, base, origin, depth + 1);
    } else if (!result.files.has(target.path)) {
      if (!result.parent.has(target.path)) result.parent.set(target.path, origin);
      queue.push(target.path);
    }
  };
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || result.files.has(file) || !isFile(file)) continue;
    result.files.add(file);
    if (!CODE.test(file)) continue; // CSS, JSON, images: leaves
    const { refs, problems } = moduleRefs(file, readFileSync(file, 'utf8'));
    result.problems.push(...problems.map((p) => relative(repoRoot, p)));
    for (const ref of refs) follow(ref.specifier, ref.form, file, file);
  }
  return result;
}

/** Root -> ... -> file, repo-relative, for a readable failure. */
export function pathTo(repoRoot: string, graph: GraphResult, file: string): string {
  const chain = [file];
  for (let f = graph.parent.get(file); f !== undefined; f = graph.parent.get(f)) chain.push(f);
  return chain
    .reverse()
    .map((f) => relative(repoRoot, f))
    .join(' -> ');
}

/** Repo paths production code must never reach (ADR 0013, section 2). */
export const HARNESS_PATHS: readonly string[] = [
  'packages/chains/src/local-dev.ts',
  'packages/chains/dist/local-dev.js',
  'apps/api/scripts/',
  'apps/api/src/harness/',
  'contracts/test/harness/',
];

/** Specifier text that names harness code, whatever it resolves to. */
export const HARNESS_SPECIFIER = /local-dev|scripts\/harness|test\/harness|\/harness\//;

/** The harness files and harness-looking external specifiers a graph reaches. */
export function harnessReached(repoRoot: string, graph: GraphResult): string[] {
  const files = [...graph.files]
    .filter((f) => HARNESS_PATHS.some((h) => relative(repoRoot, f).startsWith(h)))
    .map((f) => pathTo(repoRoot, graph, f));
  const specs = [...graph.externals]
    .filter((s) => HARNESS_SPECIFIER.test(s))
    .map((s) => `external '${s}'`);
  return [...files, ...specs];
}

/** Test files: `*.test.*` and `*.spec.*` in any source extension. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Every production source file under `dir`: tests, declaration files and `exclude` left out. */
export function productionFiles(
  dir: string,
  exclude: (path: string) => boolean = () => false,
): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (exclude(path)) return [];
    if (e.isDirectory()) return productionFiles(path, exclude);
    return CODE.test(e.name) && !TEST_FILE.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)
      ? [path]
      : [];
  });
}

/** Every `@ranvier/*` package and app source directory, for production roots. */
export function productionRoots(repoRoot: string): string[] {
  const at = (rel: string): string => join(repoRoot, rel);
  const packages = existsSync(at('packages'))
    ? readdirSync(at('packages'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(at(`packages/${e.name}/src`)))
        .map((e) => at(`packages/${e.name}/src`))
    : [];
  const localDev = at('packages/chains/src/local-dev.ts');
  return [
    // Every API module, not only main.ts: kms-smoke.ts and any other entry is built into dist/.
    // src/testing/ is included too although tsconfig.build.json leaves it out of dist/: being
    // stricter costs nothing. Left out: *.test.ts files (never built) and src/harness/, the
    // planned harness entry (PR 4), which is excluded from the build and is what we guard against.
    ...productionFiles(at('apps/api/src'), (p) => p === at('apps/api/src/harness')),
    ...(existsSync(at('apps/workers/src')) ? productionFiles(at('apps/workers/src')) : []),
    ...(existsSync(at('apps/web/src')) ? productionFiles(at('apps/web/src')) : []),
    ...(isFile(at('apps/web/next.config.ts')) ? [at('apps/web/next.config.ts')] : []),
    // Every package's sources except local-dev itself (its own tests are already left out).
    ...packages.flatMap((dir) => productionFiles(dir, (p) => p === localDev)),
  ];
}

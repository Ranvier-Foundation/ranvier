/**
 * LOCAL TEST HARNESS GUARD (ADR 0013, section 2). Never imported by `src/`.
 *
 * A static import graph over the repo's TypeScript sources, for the guard that production entry
 * points reach neither `@ranvier/chains/local-dev` nor any harness code. It follows every module
 * reference form TypeScript has: `import` (value and type), `export * from`, `export { } from`,
 * `import x = require()`, `import('...')`, `require('...')`, `require.resolve('...')` and
 * `import.meta.resolve('...')`. A dynamic form whose argument is not a string literal cannot be
 * followed, so it is reported as a problem instead of being skipped (fail closed), and so is a
 * relative or workspace specifier that does not resolve.
 *
 * Resolution: relative paths (with the `.js` -> `.ts`/`.tsx` mapping NodeNext uses), the web's
 * `@/` alias, and `@ranvier/<pkg>[/<subpath>]` through that package's `exports` map, from
 * `./dist/<x>.js` back to `src/<x>.ts`. Any other bare specifier is an external package: recorded,
 * not followed (no workspace code lives in node_modules).
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

const CODE = /\.(?:ts|tsx|mts|cts)$/;

/** Every module reference in one source file. */
export function moduleRefs(
  fileName: string,
  text: string,
): {
  refs: ModuleRef[];
  problems: string[];
} {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const refs: ModuleRef[] = [];
  const problems: string[] = [];
  const literal = (node: ts.Node | undefined): string | undefined =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const dynamic = (call: ts.CallExpression, form: string): void => {
    const spec = literal(call.arguments[0]);
    if (spec === undefined) {
      const { line } = source.getLineAndCharacterOfPosition(call.getStart());
      problems.push(`${fileName}:${line + 1}: ${form} with a non-literal argument`);
    } else {
      refs.push({ specifier: spec, form });
    }
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
  return { packages, aliasRoots: new Map([[web, join(web, 'src')]]) };
}

/** A path without extension, or with a `.js`-family one, to the source file it names. */
function resolveFile(base: string): string | undefined {
  const candidates = /\.(?:js|jsx|mjs|cjs)$/.test(base)
    ? [
        base.replace(/\.(?:js|jsx|mjs|cjs)$/, (e) =>
          e === '.mjs' ? '.mts' : e === '.cjs' ? '.cts' : '.ts',
        ),
        base.replace(/\.(?:js|jsx)$/, '.tsx'),
        base,
      ]
    : [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
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

export function resolveSpecifier(
  spec: string,
  from: string,
  ws: Workspace,
): { kind: 'file'; path: string } | { kind: 'external' } | { kind: 'unresolved' } {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const path = resolveFile(resolve(dirname(from), spec));
    return path ? { kind: 'file', path } : { kind: 'unresolved' };
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
  const ws = workspace(repoRoot);
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
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || result.files.has(file) || !isFile(file)) continue;
    result.files.add(file);
    if (!CODE.test(file)) continue; // CSS, JSON, images: leaves
    const { refs, problems } = moduleRefs(file, readFileSync(file, 'utf8'));
    result.problems.push(...problems.map((p) => relative(repoRoot, p)));
    for (const ref of refs) {
      const target = resolveSpecifier(ref.specifier, file, ws);
      if (target.kind === 'external') {
        result.externals.add(ref.specifier);
      } else if (target.kind === 'unresolved') {
        result.problems.push(
          `${relative(repoRoot, file)}: cannot resolve ${ref.form} '${ref.specifier}'`,
        );
      } else if (!result.files.has(target.path)) {
        if (!result.parent.has(target.path)) result.parent.set(target.path, file);
        queue.push(target.path);
      }
    }
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

/** Every production `.ts`/`.tsx` file under `dir` (tests and test helpers excluded). */
export function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return productionFiles(path);
    return CODE.test(e.name) && !/\.(?:test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

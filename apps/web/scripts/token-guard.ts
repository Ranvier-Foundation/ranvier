/**
 * Token guard: fails when a file under apps/web/src (other than the token definition file)
 * hard-codes a value that must come from a design token. Rules are documented in
 * docs/ui-guidelines.md ("Token guard"). Run with `pnpm guard:tokens`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type RuleId =
  'hex-colour' | 'colour-function' | 'shadow' | 'arbitrary-value' | 'inline-style' | 'css-pixel';

export interface Violation {
  file: string;
  line: number;
  column: number;
  rule: RuleId;
  match: string;
  message: string;
}

/** Files that may define values. Paths are relative to apps/web/src, with forward slashes. */
export const TOKEN_FILES: readonly string[] = ['styles/tokens.css'];

const SCANNED = /\.(?:tsx?|jsx?|mjs|cjs|css|html)$/;

const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOUR_FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const SHADOW =
  /(?<=["'`\s:])(?:(?:[\w[\]=-]+:)*)(?:box-shadow|boxShadow|(?:drop-|inset-|text-)?shadow-[\w[\]#(),./%-]+|ring-[\w[\]#(),./%-]+)(?=["'`\s;:]|$)/g;
const BOX_SHADOW = /box-?shadow/gi;
const LENGTH_UNIT = /\d(?:px|rem|em|%|vw|vh|vmin|vmax|dvh|svh|lvh|ch|ex|pt|cm|mm|pc)(?![\w])/;
const ARBITRARY = /(?:(?<=-)|(?<=["'`\s:]))\[([^\]\s]*)\]/g;
const BARE_NUMBER = /^-?\d+(?:\.\d+)?$/;
const CSS_PIXEL = /(?<![\w.-])-?\d*\.?\d+px\b/g;
const STYLE_PROP = /\bstyle\s*=\s*(?:\{\{([\s\S]*?)\}\}|"([^"]*)"|'([^']*)')/g;
const COLOUR_PROPS =
  /\b(?:color|background(?:Color)?|borderColor|outlineColor|fill|stroke|caretColor)\s*:\s*(['"`])(?!var\(--|inherit|currentColor|transparent|none)[^'"`]*\1/;

/** Replaces comments with spaces (keeping newlines) so line numbers stay correct. */
export function stripComments(source: string, isCss: boolean): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let out = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!isCss)
    out = out.replace(/(^|[^:\w'"`\\])\/\/[^\n]*/g, (m, p: string) => p + blank(m.slice(p.length)));
  return out;
}

function position(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - before.lastIndexOf('\n') };
}

/** Scans one file's text. `file` is only used in the report. */
export function scanSource(file: string, source: string): Violation[] {
  const isCss = file.endsWith('.css');
  const text = stripComments(source, isCss);
  const found: Violation[] = [];
  const add = (index: number, rule: RuleId, match: string, message: string) => {
    found.push({ file, ...position(text, index), rule, match, message });
  };

  for (const m of text.matchAll(HEX)) {
    add(m.index, 'hex-colour', m[0], 'hex colour: use a colour token');
  }
  for (const m of text.matchAll(COLOUR_FN)) {
    add(m.index, 'colour-function', m[0], 'colour function: use a colour token');
  }
  for (const m of text.matchAll(BOX_SHADOW)) {
    add(m.index, 'shadow', m[0], 'box-shadow: Ranvier has no shadows');
  }
  for (const m of text.matchAll(SHADOW)) {
    if (/box-?shadow/i.test(m[0])) continue;
    add(m.index, 'shadow', m[0], 'shadow or ring utility: Ranvier has no shadows');
  }

  for (const m of text.matchAll(ARBITRARY)) {
    const inner = m[1] ?? '';
    if (/^var\(--[\w-]+\)$/.test(inner)) continue;
    const literal =
      LENGTH_UNIT.test(inner) || BARE_NUMBER.test(inner) || /#[0-9a-fA-F]{3,8}\b/.test(inner);
    if (literal) {
      add(
        m.index,
        'arbitrary-value',
        m[0],
        'arbitrary value with a literal: use a token utility or var(--token)',
      );
    }
  }

  for (const m of text.matchAll(STYLE_PROP)) {
    const body = m[1] ?? m[2] ?? m[3] ?? '';
    const bad =
      LENGTH_UNIT.test(body) ||
      /:\s*-?(?!0(?![\d.]))\d/.test(body) ||
      COLOUR_PROPS.test(body) ||
      /#[0-9a-fA-F]{3,8}\b/.test(body);
    if (bad) {
      add(m.index, 'inline-style', m[0].slice(0, 60), 'inline style with a colour or size literal');
    }
  }

  if (isCss) {
    for (const m of text.matchAll(CSS_PIXEL)) {
      add(m.index, 'css-pixel', m[0], 'pixel literal in CSS: define a token');
    }
  }

  // The same literal can match several rules (a hex inside an arbitrary value): keep each once.
  const seen = new Set<string>();
  return found.filter((v) => {
    const key = `${v.line}:${v.column}:${v.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Scans every source file under `srcDir`, skipping the token definition file(s). */
export function scanDirectory(srcDir: string): Violation[] {
  return walk(srcDir)
    .filter((f) => SCANNED.test(f))
    .filter((f) => !TOKEN_FILES.includes(relative(srcDir, f).split(sep).join('/')))
    .flatMap((f) => scanSource(relative(join(srcDir, '..'), f), readFileSync(f, 'utf8')));
}

if (import.meta.main) {
  const srcDir = join(process.cwd(), 'src');
  const violations = scanDirectory(srcDir);
  for (const v of violations) {
    console.error(`${v.file}:${v.line}:${v.column}  ${v.rule}  ${v.match}  ${v.message}`);
  }
  if (violations.length > 0) {
    console.error(`\nToken guard: ${violations.length} violation(s).`);
    process.exit(1);
  }
  console.log('Token guard: no violations.');
}

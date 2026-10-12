import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanDirectory, scanSource, type RuleId } from '../../scripts/token-guard.ts';

const rules = (file: string, src: string): RuleId[] => scanSource(file, src).map((v) => v.rule);

describe('token guard: flagged', () => {
  it.each<[string, string, RuleId]>([
    ['hex colour in a string', `const c = '#9B2C35';`, 'hex-colour'],
    ['short hex in a class', `<p className="text-[#fff]">x</p>`, 'hex-colour'],
    ['eight digit hex', `const c = "#11223344";`, 'hex-colour'],
    ['rgb()', `const c = 'rgb(1, 2, 3)';`, 'colour-function'],
    ['rgba()', `.a { color: rgba(0, 0, 0, 0.5); }`, 'colour-function'],
    ['hsl()', `const c = 'hsl(10 20% 30%)';`, 'colour-function'],
    ['arbitrary px size', `<p className="w-[640px]">x</p>`, 'arbitrary-value'],
    ['arbitrary px under a variant', `<p className="min-[1200px]:flex">x</p>`, 'arbitrary-value'],
    ['arbitrary rem', `<p className="mt-[1.5rem]">x</p>`, 'arbitrary-value'],
    ['arbitrary bare number', `<p className="z-[12]">x</p>`, 'arbitrary-value'],
    [
      'arbitrary calc with a literal',
      `<p className="h-[calc(var(--x)+4px)]">x</p>`,
      'arbitrary-value',
    ],
    [
      'arbitrary property with a literal',
      `<p className="[margin-top:12px]">x</p>`,
      'arbitrary-value',
    ],
    ['inline style px string', `<p style={{ width: '12px' }}>x</p>`, 'inline-style'],
    ['inline style number', `<p style={{ width: 12 }}>x</p>`, 'inline-style'],
    ['inline style colour', `<p style={{ color: 'red' }}>x</p>`, 'inline-style'],
    ['inline style attribute', `<p style="margin: 4px">x</p>`, 'inline-style'],
    ['box-shadow in css', `.a { box-shadow: 0 0 0 var(--x); }`, 'shadow'],
    ['boxShadow in style', `<p style={{ boxShadow: v }}>x</p>`, 'shadow'],
    ['shadow utility', `<p className="shadow-md">x</p>`, 'shadow'],
    ['ring utility', `<p className="ring-2 ring-primary">x</p>`, 'shadow'],
    ['pixel literal in css', `.a { margin: 12px; }`, 'css-pixel'],
  ])('%s', (_name, src, rule) => {
    const file = rule === 'css-pixel' || src.startsWith('.a') ? 'a.css' : 'a.tsx';
    expect(rules(file, src)).toContain(rule);
  });

  it('reports line and column', () => {
    const [v] = scanSource('a.tsx', `line one\nconst c = '#fff';`);
    expect(v).toMatchObject({ line: 2, rule: 'hex-colour' });
  });
});

describe('token guard: allowed', () => {
  it.each<[string, string, string]>([
    ['token utilities', 'a.tsx', `<p className="bg-primary p-24 text-amount rounded-pill">x</p>`],
    [
      'var() arbitrary value',
      'a.tsx',
      `<p className="w-[var(--panel)] bg-[var(--color-ink)]">x</p>`,
    ],
    [
      'selector variants',
      'a.tsx',
      `<a className="aria-[current=page]:bg-pill data-[open=true]:flex">x</a>`,
    ],
    [
      'grid template without literals',
      'a.tsx',
      `<p className="grid-cols-[minmax(0,1fr)_auto]">x</p>`,
    ],
    [
      'dynamic inline style',
      'a.tsx',
      `<p style={{ fontSize: g.fontSize, left: 0, top: g.step }}>x</p>`,
    ],
    ['css variable inline style', 'a.tsx', `<p style={{ color: 'var(--color-ink)' }}>x</p>`],
    ['array index', 'a.ts', `const x = list[0]; const y = map['k'];`],
    ['anchor fragment', 'a.tsx', `<a href="#main">x</a><a href="#">y</a>`],
    ['var() in css', 'a.css', `.a { margin: var(--spacing-12); color: var(--color-ink); }`],
    ['comments', 'a.tsx', `// #9B2C35 and 12px\n/* rgb(0,0,0) box-shadow */ const a = 1;`],
    ['url with double slash', 'a.ts', `const u = 'https://example.com/#top';\nconst c = 1;`],
  ])('%s', (_name, file, src) => {
    expect(scanSource(file, src)).toEqual([]);
  });
});

describe('token guard: directory scan', () => {
  it('skips the token file and scans the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'guard-'));
    const src = join(root, 'src');
    mkdirSync(join(src, 'styles'), { recursive: true });
    writeFileSync(join(src, 'styles', 'tokens.css'), '@theme { --color-ink: #1c1011; }');
    writeFileSync(join(src, 'a.tsx'), `export const c = '#fff';`);
    const result = scanDirectory(src);
    expect(result.map((v) => v.file)).toEqual(['src/a.tsx']);
  });

  it('passes on the real source tree', () => {
    expect(scanDirectory(join(process.cwd(), 'src'))).toEqual([]);
  });
});

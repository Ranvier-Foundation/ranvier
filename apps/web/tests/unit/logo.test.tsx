import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LOGO_SIZES, Logo, type LogoSize } from '../../src/components/logo';
import { logoGeometry } from '../../src/components/logo-geometry';

/** docs/ui-guidelines.md section 4 table (square, gap, mark box), plus the canvas offsets. */
const TABLE = [
  { context: 'Web header', fs: 32, square: 6, gap: 2, step: 8, box: 14, lift: 8, spaceBefore: 3 },
  {
    context: 'Mobile header',
    fs: 29,
    square: 6,
    gap: 2,
    step: 8,
    box: 14,
    lift: 6,
    spaceBefore: 3,
  },
  { context: 'Payment card', fs: 22, square: 4, gap: 1, step: 5, box: 9, lift: 6, spaceBefore: 2 },
  { context: 'Secured by', fs: 15, square: 3, gap: 1, step: 4, box: 7, lift: 3, spaceBefore: 2 },
];

describe('logo geometry', () => {
  it.each(TABLE.map((row) => [row.context, row] as const))('%s', (_name, row) => {
    const { fs, context, ...expected } = row;
    expect(context).toBeTruthy();
    const g = logoGeometry(fs);
    expect(g).toMatchObject(expected);
    expect(g.step).toBe(g.square + g.gap);
  });

  it('uses the large-size ratios from 60 px', () => {
    expect(logoGeometry(60)).toMatchObject({ square: 9, gap: 2 });
    expect(logoGeometry(59)).toMatchObject({ square: 11, gap: 3 });
  });

  it('returns whole pixels and a gap of at least 1 px', () => {
    for (let fs = 8; fs <= 120; fs++) {
      const g = logoGeometry(fs);
      for (const v of Object.values(g)) expect(Number.isInteger(v)).toBe(true);
      expect(g.gap).toBeGreaterThanOrEqual(1);
    }
  });

  it('rejects fractional sizes', () => {
    expect(() => logoGeometry(31.5)).toThrow(RangeError);
  });
});

const root = process.cwd();
const tokensCss = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8');
const globalsCss = readFileSync(join(root, 'src/app/globals.css'), 'utf8');
const token = (name: string) => {
  const m = new RegExp(`--${name}:\\s*(\\d+)px;`).exec(tokensCss);
  if (!m) throw new Error(`token --${name} missing or not a whole-pixel value`);
  return Number(m[1]);
};

describe('Logo tokens equal logoGeometry', () => {
  it.each(TABLE)('$context ($fs px)', ({ fs, square, gap, box, lift, spaceBefore }) => {
    const g = logoGeometry(fs);
    expect(token(`logo-${fs}-size`)).toBe(g.fontSize);
    expect(token(`logo-${fs}-square`)).toBe(g.square);
    expect(token(`logo-${fs}-gap`)).toBe(g.gap);
    expect(token(`logo-${fs}-box`)).toBe(g.box);
    expect(token(`logo-${fs}-lift`)).toBe(g.lift);
    expect(token(`logo-${fs}-space`)).toBe(g.spaceBefore);
    expect(token(`logo-${fs}-square`) * 2 + token(`logo-${fs}-gap`)).toBe(g.box);
    expect([square, gap, box, lift, spaceBefore]).toEqual([
      g.square,
      g.gap,
      g.box,
      g.lift,
      g.spaceBefore,
    ]);
  });

  it('has exactly the reference sizes', () => {
    expect([...LOGO_SIZES].sort()).toEqual(TABLE.map((r) => r.fs).sort());
    const declared = [...tokensCss.matchAll(/--logo-(\d+)-size:/g)].map((m) => Number(m[1]));
    expect(declared.sort()).toEqual([...LOGO_SIZES].sort());
  });

  it.each(TABLE)('$fs px class maps to its own tokens', ({ fs }) => {
    const rule = new RegExp(`\\.logo-${fs}\\s*\\{([^}]*)\\}`).exec(globalsCss)?.[1] ?? '';
    for (const part of ['size', 'square', 'gap', 'box', 'lift', 'space']) {
      expect(rule).toContain(`--logo-${part}: var(--logo-${fs}-${part});`);
    }
  });
});

describe('Logo markup at every reference size', () => {
  it.each(TABLE)('$context uses the size class and no inline style', ({ fs }) => {
    const html = renderToStaticMarkup(<Logo size={fs as LogoSize} />);
    expect(html).toContain(`data-logo="${fs}"`);
    expect(html).toContain(`logo-${fs}`);
    expect(html).toContain('logo-square-low');
    expect(html).toContain('logo-square-high');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('style=');
  });

  it('draws wordmark white with blush nodes on deep', () => {
    const html = renderToStaticMarkup(<Logo size={32} tone="deep" />);
    expect(html).toContain('text-on-primary');
    expect(html).toContain('text-blush');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const tokens = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8');
const guidelines = readFileSync(join(root, '../../docs/ui-guidelines.md'), 'utf8');

function tokenValue(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim().toLowerCase();
}

/** Rows of the colour table in the guidelines: | `name` | `#HEX` | ... */
const colourRows = [
  ...guidelines.matchAll(/^\| `([\w-]+)`\s+\| `(#[0-9A-Fa-f]{6}|rgba\([^`]+\))`/gm),
].map((m) => ({ name: m[1]!, value: m[2]!.toLowerCase() }));
const statusRows = [
  ...guidelines.matchAll(
    /^\| (Success|Warning|Danger|Neutral)[^|]*\| `(#[0-9A-Fa-f]{6})` \| `(#[0-9A-Fa-f]{6})`/gm,
  ),
].map((m) => ({ name: m[1]!.toLowerCase(), text: m[2]!.toLowerCase(), tint: m[3]!.toLowerCase() }));

describe('tokens match docs/ui-guidelines.md', () => {
  it('finds the whole colour table', () => {
    const names = colourRows.map((r) => r.name);
    for (const n of [
      'bg',
      'surface',
      'ink',
      'sub',
      'line',
      'pill',
      'primary',
      'accent',
      'blush',
      'deep',
      'deep-muted',
      'deep-muted2',
      'deep-tile',
      'scrim',
      'border-strong',
      'switch-off',
      'row-hover',
    ]) {
      expect(names).toContain(n);
    }
  });

  it.each(colourRows)('colour $name', ({ name, value }) => {
    expect(tokenValue(`color-${name}`)?.replace(/\s+/g, '')).toBe(value.replace(/\s+/g, ''));
  });

  it('finds the four status rows', () => {
    expect(statusRows.map((r) => r.name)).toEqual(['success', 'warning', 'danger', 'neutral']);
  });

  it.each(statusRows)('status $name', ({ name, text, tint }) => {
    expect(tokenValue(`color-${name}-text`)).toBe(text);
    expect(tokenValue(`color-${name}-tint`)).toBe(tint);
  });

  it('has none of the retired names', () => {
    for (const old of ['canvas', 'muted', 'chip', 'brand', 'brand-deep']) {
      expect(tokens).not.toMatch(new RegExp(`--color-${old}:`));
    }
  });

  it('defines the two radii and the 150 ms motion', () => {
    expect(tokenValue('radius-none')).toBe('0px');
    expect(tokenValue('radius-pill')).toBe('999px');
    expect(tokenValue('default-transition-duration')).toBe('150ms');
  });

  it('defines every spacing step in the guidelines', () => {
    for (const px of [4, 6, 8, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 88, 120]) {
      expect(tokenValue(`spacing-${px}`)).toBe(`${px}px`);
    }
  });

  it('defines the type styles', () => {
    expect(tokenValue('text-display')).toBe('48px');
    expect(tokenValue('text-h1')).toBe('40px');
    expect(tokenValue('text-h2')).toBe('32px');
    expect(tokenValue('text-amount')).toBe('36px');
    expect(tokenValue('text-amount--font-weight')).toBe('400');
    expect(tokenValue('text-body')).toBe('15px');
  });
});

describe('Inter variable font with the optical-size axis', () => {
  const pkg = join(root, 'node_modules/@fontsource-variable/inter');
  const meta = JSON.parse(readFileSync(join(pkg, 'metadata.json'), 'utf8')) as {
    variable: Record<string, { min: string; max: string }>;
  };

  it('ships an opsz axis of 14 to 32 and weights covering 300 to 800', () => {
    expect(meta.variable.opsz).toMatchObject({ min: '14', max: '32' });
    expect(Number(meta.variable.wght?.min)).toBeLessThanOrEqual(300);
    expect(Number(meta.variable.wght?.max)).toBeGreaterThanOrEqual(800);
  });

  it('opsz.css points at the opsz files and the layout imports it', () => {
    const css = readFileSync(join(pkg, 'opsz.css'), 'utf8');
    expect(css).toMatch(/inter-latin-opsz-normal\.woff2/);
    expect(css).toMatch(/font-weight: 100 900/);
    const layout = readFileSync(join(root, 'src/app/layout.tsx'), 'utf8');
    expect(layout).toContain('@fontsource-variable/inter/opsz.css');
  });
});

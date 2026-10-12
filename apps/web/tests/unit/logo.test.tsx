import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Logo } from '../../src/components/logo';
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

describe('Logo markup at every reference size', () => {
  it.each(TABLE)(
    '$context renders $square px squares in a $box px box',
    ({ fs, square, step, box, lift, spaceBefore }) => {
      const html = renderToStaticMarkup(<Logo size={fs} />);
      expect(html).toContain(`font-size:${fs}px`);
      expect(html).toContain(
        `width:${box}px;height:${box}px;margin-bottom:${lift}px;margin-left:${spaceBefore}px`,
      );
      expect(html).toContain(`left:0;top:${step}px;width:${square}px;height:${square}px`);
      expect(html).toContain(`left:${step}px;top:0;width:${square}px;height:${square}px`);
    },
  );

  it('draws wordmark white with blush nodes on deep', () => {
    const html = renderToStaticMarkup(<Logo size={32} tone="deep" />);
    expect(html).toContain('text-on-primary');
    expect(html).toContain('text-blush');
  });
});

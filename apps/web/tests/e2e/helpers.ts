import type { Locator, Page } from '@playwright/test';

/** Computed style values for a locator, as the browser reports them. */
export async function styles<K extends string>(
  locator: Locator,
  props: readonly K[],
): Promise<Record<K, string>> {
  return locator.evaluate((el, names) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n)]));
  }, props) as Promise<Record<K, string>>;
}

export async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

export function parseRgb(value: string): [number, number, number] {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value);
  if (!m) throw new Error(`not an rgb colour: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(parseRgb(a));
  const lb = luminance(parseRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Canvas colours as the browser reports them (rgb). Independent of the token file on purpose. */
export const RGB = {
  bg: 'rgb(247, 244, 242)',
  surface: 'rgb(255, 255, 255)',
  ink: 'rgb(28, 16, 17)',
  sub: 'rgb(110, 95, 97)',
  line: 'rgb(239, 232, 229)',
  pill: 'rgb(237, 230, 226)',
  primary: 'rgb(59, 21, 25)',
  accent: 'rgb(155, 44, 53)',
  blush: 'rgb(242, 184, 166)',
  white: 'rgb(255, 255, 255)',
} as const;

export async function gotoSwap(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
}

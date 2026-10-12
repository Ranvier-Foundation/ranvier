import { expect, test, type Page } from '@playwright/test';
import { box, contrast, gotoSwap, RGB, styles } from './helpers';

const header = (page: Page) => page.getByRole('banner');
const panel = (page: Page) => page.getByRole('region', { name: 'Swap' });
const flip = (page: Page) => page.getByRole('button', { name: 'Switch pay and receive' });
const cta = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Connect wallet' });

test.describe('swap screen at 1440x900: geometry and computed styles', () => {
  test.beforeEach(async ({ page }) => gotoSwap(page, 1440, 900));

  test('security headers still apply', async ({ page }) => {
    const res = await page.request.get('/');
    const h = res.headers();
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['strict-transport-security']).toContain('max-age=63072000');
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['x-powered-by']).toBeUndefined();
  });

  test('page background and hidden title', async ({ page }) => {
    expect((await styles(page.locator('body'), ['background-color']))['background-color']).toBe(
      RGB.bg,
    );
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveText('Ranvier swap');
    const b = await box(h1);
    expect(b.width).toBeLessThanOrEqual(1);
    expect(b.height).toBeLessThanOrEqual(1);
  });

  test('panel: max width 640, centred, square, surface, no shadow', async ({ page }) => {
    const p = panel(page);
    const b = await box(p);
    expect(b.width).toBe(640);
    expect(b.x).toBe(400);
    expect(await styles(p, ['background-color', 'border-top-left-radius', 'box-shadow'])).toEqual({
      'background-color': RGB.surface,
      'border-top-left-radius': '0px',
      'box-shadow': 'none',
    });
    // 64 px above the panel under a 76 px header, 20 px page padding.
    expect(b.y).toBe(76 + 64);
  });

  test('rows: paddings 24/24/32 and 32/24/26, labels 14px sub', async ({ page }) => {
    const rows = panel(page).locator(':scope > div');
    const top = await styles(rows.nth(0), [
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
    ]);
    expect(top).toEqual({
      'padding-top': '24px',
      'padding-right': '24px',
      'padding-bottom': '32px',
      'padding-left': '24px',
    });
    const bottom = await styles(rows.nth(2), [
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
    ]);
    expect(bottom).toEqual({
      'padding-top': '32px',
      'padding-right': '24px',
      'padding-bottom': '26px',
      'padding-left': '24px',
    });
    for (const label of [page.locator('label[for=pay]'), page.locator('label[for=receive]')]) {
      expect(await styles(label, ['font-size', 'color'])).toEqual({
        'font-size': '14px',
        color: RGB.sub,
      });
    }
    await expect(page.locator('label[for=pay]')).toHaveText('Pay on Ethereum');
    await expect(page.locator('label[for=receive]')).toHaveText('Receive on Base');
  });

  test('hairline is 1px in the line colour', async ({ page }) => {
    const hairline = flip(page).locator('..');
    const b = await box(hairline);
    expect(b.height).toBe(1);
    expect((await styles(hairline, ['background-color']))['background-color']).toBe(RGB.line);
  });

  test('amount: 36px / 400, tabular numbers, ss01, -0.02em', async ({ page }) => {
    const input = page.locator('#pay');
    const s = await styles(input, [
      'font-size',
      'font-weight',
      'font-variant-numeric',
      'font-feature-settings',
      'letter-spacing',
      'color',
    ]);
    expect(s['font-size']).toBe('36px');
    expect(s['font-weight']).toBe('400');
    expect(s['font-variant-numeric']).toContain('tabular-nums');
    expect(s['font-feature-settings']).toContain('"tnum"');
    expect(s['font-feature-settings']).toContain('"ss01"');
    expect(s['letter-spacing']).toBe('-0.72px');
    expect(s.color).toBe(RGB.ink);
    await expect(input).toHaveAttribute('placeholder', '0');
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('inputmode', 'decimal');
  });

  test('token names and receive amount: 36px / 400 in sub', async ({ page }) => {
    for (const el of [
      page.getByRole('link', { name: 'Pay token: ETH, change' }),
      page.getByRole('link', { name: 'Receive token: USDC, change' }),
      page.locator('#receive'),
    ]) {
      const s = await styles(el, ['font-size', 'font-weight', 'color', 'font-variant-numeric']);
      expect(s['font-size']).toBe('36px');
      expect(s['font-weight']).toBe('400');
      expect(s.color).toBe(RGB.sub);
    }
  });

  test('USD values: 15px, right-aligned, pay in accent and receive in sub', async ({ page }) => {
    const pay = page.getByRole('button', { name: 'Show amount in USD' });
    const recv = panel(page).getByText('$0.00').last();
    for (const [el, colour] of [
      [pay, RGB.accent],
      [recv, RGB.sub],
    ] as const) {
      const s = await styles(el, [
        'font-size',
        'color',
        'font-variant-numeric',
        'font-feature-settings',
      ]);
      expect(s['font-size']).toBe('15px');
      expect(s.color).toBe(colour);
      expect(s['font-variant-numeric']).toContain('tabular-nums');
      expect(s['font-feature-settings']).toContain('"ss01"');
      const b = await box(el);
      expect(b.x + b.width).toBeCloseTo(400 + 640 - 24, 0);
    }
  });

  test('flip button: 44x44 square, primary, blush squares, centred on the hairline', async ({
    page,
  }) => {
    const f = flip(page);
    const b = await box(f);
    expect([b.width, b.height]).toEqual([44, 44]);
    expect(await styles(f, ['background-color', 'border-top-left-radius', 'box-shadow'])).toEqual({
      'background-color': RGB.primary,
      'border-top-left-radius': '0px',
      'box-shadow': 'none',
    });
    const h = await box(f.locator('..'));
    expect(b.x + 22).toBe(400 + 320);
    expect(b.y).toBe(h.y - 22);
    const fills = await f
      .locator('rect')
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).fill));
    expect(fills).toEqual([RGB.blush, RGB.blush]);
  });

  test('connect button: 264x56 pill, primary, 16px / 500, 16px under the panel', async ({
    page,
  }) => {
    const c = cta(page);
    const b = await box(c);
    expect([b.width, b.height]).toEqual([264, 56]);
    expect(b.x).toBe((1440 - 264) / 2);
    expect(b.y).toBe((await box(panel(page))).y + (await box(panel(page))).height + 16);
    expect(
      await styles(c, [
        'border-top-left-radius',
        'background-color',
        'color',
        'font-size',
        'font-weight',
      ]),
    ).toEqual({
      'border-top-left-radius': '999px',
      'background-color': RGB.primary,
      color: RGB.white,
      'font-size': '16px',
      'font-weight': '500',
    });
  });

  test('no shadows anywhere', async ({ page }) => {
    const withShadow = await page.evaluate(
      () =>
        [...document.querySelectorAll('body *')].filter(
          (e) => getComputedStyle(e).boxShadow !== 'none',
        ).length,
    );
    expect(withShadow).toBe(0);
  });

  test('every pressable is a pill or round, every container square', async ({ page }) => {
    const radii = await page.evaluate(() =>
      [...document.querySelectorAll('a, button')].map((e) => ({
        name: e.getAttribute('aria-label') ?? e.textContent?.trim() ?? '',
        radius: getComputedStyle(e).borderTopLeftRadius,
        w: e.getBoundingClientRect().width,
        h: e.getBoundingClientRect().height,
      })),
    );
    const allowed = new Set(['999px', '50%', '0px']);
    for (const r of radii) expect(allowed, `${r.name}: ${r.radius}`).toContain(r.radius);
    // The flip button is the one square control.
    expect(radii.filter((r) => r.radius === '0px' && r.h >= 44).map((r) => r.name)).toContain(
      'Switch pay and receive',
    );
  });

  test('contrast tokens meet WCAG AA', async () => {
    expect(contrast(RGB.sub, RGB.surface)).toBeGreaterThanOrEqual(5.9);
    expect(contrast(RGB.sub, RGB.bg)).toBeGreaterThanOrEqual(5.4);
    expect(contrast(RGB.white, RGB.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(RGB.accent, RGB.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(RGB.ink, RGB.pill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(RGB.white, RGB.accent)).toBeGreaterThanOrEqual(4.5);
  });

  test('Inter loads with a working optical-size axis', async ({ page }) => {
    const widths = await page.evaluate(async () => {
      await document.fonts.load("400 36px 'Inter Variable'", 'Ranvier swap 0123');
      const measure = (opsz: number) => {
        const s = document.createElement('span');
        s.textContent = 'Ranvier swap 0123456789';
        s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:400 36px 'Inter Variable';font-variation-settings:'opsz' ${opsz}`;
        document.body.append(s);
        const w = s.getBoundingClientRect().width;
        s.remove();
        return w;
      };
      return {
        opsz14: measure(14),
        opsz32: measure(32),
        family: getComputedStyle(document.body).fontFamily,
      };
    });
    expect(widths.family).toContain('Inter Variable');
    expect(widths.opsz14).toBeGreaterThan(widths.opsz32 + 5);
  });
});

test.describe('header at 1440 and 1200: one line, 44px controls', () => {
  for (const width of [1440, 1200]) {
    test(`header geometry at ${width}`, async ({ page }) => {
      await gotoSwap(page, width, 900);
      const h = header(page);
      expect(
        await styles(h, [
          'display',
          'padding-top',
          'padding-right',
          'padding-bottom',
          'padding-left',
          'column-gap',
          'white-space',
        ]),
      ).toEqual({
        display: 'grid',
        'padding-top': '16px',
        'padding-right': '20px',
        'padding-bottom': '16px',
        'padding-left': '20px',
        'column-gap': '20px',
        'white-space': 'nowrap',
      });
      expect((await box(h)).height).toBe(76);

      const nav = h.getByRole('navigation', { name: 'Main' });
      await expect(nav).toBeVisible();
      expect((await styles(nav, ['column-gap']))['column-gap']).toBe('4px');
      const items = nav.getByRole('link');
      await expect(items).toHaveText(['Swap', 'Trade', 'Buy', 'Activity', 'Portfolio']);
      const tops = new Set<number>();
      for (let i = 0; i < 5; i++) {
        const el = items.nth(i);
        const b = await box(el);
        tops.add(b.y);
        expect(b.height).toBe(44);
        const s = await styles(el, [
          'font-size',
          'padding-left',
          'padding-right',
          'border-top-left-radius',
          'font-weight',
          'background-color',
        ]);
        expect(s['font-size']).toBe('16px');
        expect([s['padding-left'], s['padding-right']]).toEqual(['14px', '14px']);
        expect(s['border-top-left-radius']).toBe('999px');
        expect(s['font-weight']).toBe(i === 0 ? '500' : '400');
        if (i === 0) expect(s['background-color']).toBe(RGB.pill);
      }
      expect(tops.size).toBe(1);
      await expect(items.first()).toHaveAttribute('aria-current', 'page');
      // Activity badge is hidden at zero.
      await expect(nav.locator('[aria-hidden=true]')).toHaveCount(0);

      const right = [
        h.getByRole('button', { name: /^Network:/ }),
        h.getByRole('button', { name: 'Connect wallet' }),
        h.getByRole('link', { name: 'Notifications' }),
        h.getByRole('button', { name: 'More' }),
      ];
      const rightTops = new Set<number>();
      for (const el of right) {
        const b = await box(el);
        rightTops.add(b.y);
        expect(b.height).toBe(44);
      }
      expect(rightTops.size).toBe(1);
      expect(rightTops.has((await box(items.first())).y)).toBe(true);
      expect((await box(h.getByRole('link', { name: 'Notifications' }))).width).toBe(44);
      expect((await box(h.getByRole('button', { name: 'More' }))).width).toBe(44);
      const rightGroup = h.getByRole('button', { name: 'More' }).locator('xpath=../..');
      expect((await styles(rightGroup, ['column-gap']))['column-gap']).toBe('6px');

      const connect = await styles(right[1]!, [
        'padding-left',
        'padding-right',
        'font-size',
        'font-weight',
        'background-color',
        'color',
        'border-top-left-radius',
      ]);
      expect(connect).toEqual({
        'padding-left': '18px',
        'padding-right': '18px',
        'font-size': '15px',
        'font-weight': '500',
        'background-color': RGB.primary,
        color: RGB.white,
        'border-top-left-radius': '999px',
      });
      const network = await styles(right[0]!, [
        'padding-left',
        'padding-right',
        'column-gap',
        'font-size',
        'background-color',
        'border-top-left-radius',
      ]);
      expect(network).toEqual({
        'padding-left': '7px',
        'padding-right': '14px',
        'column-gap': '8px',
        'font-size': '15px',
        'background-color': RGB.pill,
        'border-top-left-radius': '999px',
      });
      expect((await box(right[0]!.locator('span').first())).width).toBe(30);
      for (const icon of [right[2]!, right[3]!]) {
        expect(await styles(icon, ['background-color', 'border-top-left-radius'])).toEqual({
          'background-color': RGB.pill,
          'border-top-left-radius': '50%',
        });
      }

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      // The nav copy inside the menu stays hidden at this width.
      await page.getByRole('button', { name: 'More' }).click();
      await expect(page.getByRole('navigation', { name: 'Menu' })).toBeHidden();
      await expect(page.getByRole('link', { name: 'Account and settings' })).toBeVisible();
    });
  }

  test('logo at 32px: 14px mark box, 6px squares stepping 8px, 3px from the word', async ({
    page,
  }) => {
    await gotoSwap(page, 1440, 900);
    const logo = header(page).locator('[data-logo="32"]');
    expect(
      await styles(logo, ['font-size', 'font-weight', 'letter-spacing', 'line-height', 'color']),
    ).toEqual({
      'font-size': '32px',
      'font-weight': '700',
      'letter-spacing': '-1.76px',
      'line-height': '32px',
      color: RGB.ink,
    });
    const mark = logo.locator('[data-logo-mark]');
    const m = await box(mark);
    expect([m.width, m.height]).toEqual([14, 14]);
    expect(await styles(mark, ['margin-bottom', 'margin-left', 'color'])).toEqual({
      'margin-bottom': '8px',
      'margin-left': '3px',
      color: RGB.accent,
    });
    const [low, up] = await mark.locator('span').all();
    const lb = await box(low!);
    const ub = await box(up!);
    expect([lb.width, lb.height, ub.width, ub.height]).toEqual([6, 6, 6, 6]);
    expect([lb.x - m.x, lb.y - m.y]).toEqual([0, 8]);
    expect([ub.x - m.x, ub.y - m.y]).toEqual([8, 0]);
  });
});

test.describe('header collapse below 1200px', () => {
  for (const [width, height] of [
    [1199, 800],
    [768, 1024],
  ] as const) {
    test(`nav collapses into the more menu at ${width}`, async ({ page }) => {
      await gotoSwap(page, width, height);
      const h = header(page);
      await expect(h.getByRole('navigation', { name: 'Main' })).toBeHidden();
      expect((await box(h)).height).toBe(76);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);

      const more = h.getByRole('button', { name: 'More' });
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      const menu = page.getByRole('navigation', { name: 'Menu' });
      await expect(menu.getByRole('link')).toHaveText([
        'Swap',
        'Trade',
        'Buy',
        'Activity',
        'Portfolio',
      ]);
      await expect(menu.getByRole('link', { name: 'Swap' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      for (const l of await menu.getByRole('link').all()) expect((await box(l)).height).toBe(44);

      await page.keyboard.press('Escape');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(more).toBeFocused();
      await expect(menu).toBeHidden();
    });
  }

  test('no horizontal overflow and a single header line at 390x844', async ({ page }) => {
    await gotoSwap(page, 390, 844);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const h = header(page);
    expect((await box(h)).height).toBe(76);
    const controls = await h.locator('a:visible, button:visible').all();
    const tops = new Set<number>();
    for (const c of controls) {
      const b = await box(c);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
      if (b.height === 44) tops.add(b.y);
    }
    expect(tops.size).toBe(1);
    const p = await box(panel(page));
    expect(p.width).toBe(350);
    expect(p.x).toBe(20);
    expect((await styles(page.locator('#pay'), ['font-size']))['font-size']).toBe('36px');
    const c = await box(cta(page));
    expect([c.width, c.height]).toEqual([264, 56]);
  });
});

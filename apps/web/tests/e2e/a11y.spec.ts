import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { gotoSwap, RGB, styles } from './helpers';

const VIEWPORTS = [
  [1440, 900],
  [1200, 800],
  [768, 1024],
  [390, 844],
] as const;

async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
}

test.describe('axe', () => {
  for (const [w, h] of VIEWPORTS) {
    test(`no violations at ${w}x${h}`, async ({ page }) => {
      await gotoSwap(page, w, h);
      expect((await scan(page)).violations).toEqual([]);
    });
  }

  test('no violations with the more menu open at 768', async ({ page }) => {
    await gotoSwap(page, 768, 1024);
    await page.getByRole('button', { name: 'More' }).click();
    expect((await scan(page)).violations).toEqual([]);
  });
});

test.describe('keyboard', () => {
  test('tab reaches every control in reading order with visible focus', async ({ page }) => {
    await gotoSwap(page, 1440, 900);
    const expected = [
      'Ranvier home',
      'Swap',
      'Trade',
      'Buy',
      'Activity',
      'Portfolio',
      'Network: Ethereum',
      'Connect wallet',
      'Notifications',
      'More',
      'Change chain, currently Ethereum',
      'Swap settings, slippage auto',
      '#pay',
      'Pay token: ETH, change',
      'Show amount in USD',
      'Switch pay and receive',
      'Change chain, currently Base',
      'Receive token: USDC, change',
      'Connect wallet',
    ];
    const seen: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const cs = getComputedStyle(el);
        return {
          id: el.id,
          name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
          style: cs.outlineStyle,
          width: cs.outlineWidth,
          offset: cs.outlineOffset,
          colour: cs.outlineColor,
          focusVisible: el.matches(':focus-visible'),
        };
      });
      seen.push(info.id ? `#${info.id}` : info.name);
      expect(info.focusVisible).toBe(true);
      expect(info.style).toBe('solid');
      expect(info.colour).not.toBe('rgba(0, 0, 0, 0)');
      if (info.id === 'pay') {
        // Inputs show a 1.5px inset primary ring instead of the offset outline.
        expect(['1px', '1.5px']).toContain(info.width);
        expect(info.offset).toBe(info.width === '1.5px' ? '-1.5px' : '-1.5px');
        expect(info.colour).toBe(RGB.primary);
      } else {
        expect(info.width).toBe('2px');
        expect(info.offset).toBe('2px');
      }
    }
    expect(seen).toEqual(expected);
    // Filled primary buttons use a primary outline so the ring shows on the light page.
    for (const name of ['Connect wallet']) {
      const el = page.getByRole('main').getByRole('button', { name });
      await el.focus();
      expect((await styles(el, ['outline-color']))['outline-color']).toBe(RGB.primary);
    }
  });

  test('the more menu is reachable and operable by keyboard at 768', async ({ page }) => {
    await gotoSwap(page, 768, 1024);
    const more = page.getByRole('button', { name: 'More' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Swap' }),
    ).toBeFocused();
  });
});

test.describe('reduced motion', () => {
  test('colour fades are 150ms by default and off with prefers-reduced-motion', async ({
    page,
  }) => {
    await gotoSwap(page, 1440, 900);
    const connect = page.getByRole('main').getByRole('button', { name: 'Connect wallet' });
    expect((await styles(connect, ['transition-duration']))['transition-duration']).toBe('0.15s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await styles(connect, ['transition-duration']))['transition-duration']).toBe('0s');
    const nav = page.getByRole('link', { name: 'Trade' });
    expect((await styles(nav, ['transition-duration']))['transition-duration']).toBe('0s');
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { NOT_FOUND_ROUTE } from './routes';
import { installWallets, DEFAULT_WALLET } from './wallet-fixture';

/**
 * The app must emit zero inline styles so the Content Security Policy can drop
 * `style-src 'unsafe-inline'`. Checked in the production build, at both widths, on the screens
 * that render the most markup. Style attributes that appear and vanish again (an animation or a
 * library setting `el.style`) are caught by a MutationObserver installed before any page script.
 *
 * One exception, by design: Next's `<next-route-announcer>` (an accessibility live region it
 * appends to the body) is styled through the CSSOM (`el.style.cssText = ...`), which leaves a
 * `style` attribute in the DOM but is not an inline style as far as CSP is concerned: CSP
 * blocks style attributes in markup, inline `<style>` and `setAttribute('style')`, not CSSOM
 * writes. It is excluded here by name and the CSP experiment in the PR covers it. Everything else
 * counts.
 */

const ANNOUNCER = 'next-route-announcer';
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

async function watch(page: Page) {
  await page.addInitScript((announcer) => {
    const w = window as unknown as { __styleHits: string[] };
    w.__styleHits = [];
    const hit = (what: string) => w.__styleHits.push(what);
    // Style attributes set at any time, on any node, including ones removed again.
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && (r.target as Element).localName !== announcer)
          hit(`attribute style on <${(r.target as Element).localName}>`);
        for (const n of r.addedNodes) {
          if (!(n instanceof Element) || n.localName === announcer) continue;
          if (n.localName === 'style' || n.hasAttribute('style'))
            hit(`added <${n.localName}> with style`);
          for (const e of n.querySelectorAll('style,[style]')) hit(`added <${e.localName}>`);
        }
      }
    }).observe(document, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true,
    });
    // CSSOM entry points: constructable and programmatic stylesheets.
    const CS = CSSStyleSheet.prototype;
    for (const m of ['insertRule', 'replace', 'replaceSync', 'addRule'] as const) {
      const orig = CS[m] as unknown as ((...a: unknown[]) => unknown) | undefined;
      if (orig)
        (CS as unknown as Record<string, unknown>)[m] = function (this: unknown, ...a: unknown[]) {
          hit(`CSSStyleSheet.${m}`);
          return orig.apply(this, a);
        };
    }
    const adopted = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
    if (adopted?.set)
      Object.defineProperty(Document.prototype, 'adoptedStyleSheets', {
        ...adopted,
        set(v) {
          hit('adoptedStyleSheets');
          adopted.set!.call(this, v);
        },
      });
    const setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string) {
      if (name.toLowerCase() === 'style') hit('setAttribute(style)');
      return setAttr.call(this, name, value);
    };
  }, ANNOUNCER);
}

async function expectNoInlineStyles(page: Page) {
  const result = await page.evaluate(
    (ANNOUNCER) => ({
      attrs: document.querySelectorAll(`[style]:not(${ANNOUNCER})`).length,
      elements: document.querySelectorAll('style').length,
      adopted: document.adoptedStyleSheets.length,
      hits: (window as unknown as { __styleHits: string[] }).__styleHits,
    }),
    ANNOUNCER,
  );
  expect(result).toEqual({ attrs: 0, elements: 0, adopted: 0, hits: [] });
}

for (const { width, height } of WIDTHS) {
  test.describe(`no inline styles at ${width}`, () => {
    test.use({ viewport: { width, height } });

    test('swap screen', async ({ page }) => {
      await watch(page);
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      await expectNoInlineStyles(page);
    });

    test('unknown route is a 404 with no inline styles', async ({ page }) => {
      await watch(page);
      const response = await page.goto(NOT_FOUND_ROUTE);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'This page is not built yet',
      );
      await expect(page.getByRole('link', { name: 'Back to Swap' })).toHaveAttribute('href', '/');
      await page.evaluate(() => document.fonts.ready);
      await expectNoInlineStyles(page);
    });

    test('404 page passes the axe scan and its link is a 44 px target', async ({ page }) => {
      await page.goto(NOT_FOUND_ROUTE);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();
      expect(results.violations).toEqual([]);
      const link = await page.getByRole('link', { name: 'Back to Swap' }).boundingBox();
      expect(link?.height).toBe(44);
    });

    test('menus open', async ({ page }) => {
      await watch(page);
      await page.goto('/');
      const more = page.getByRole('banner').getByRole('button', { name: 'More' });
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      await expectNoInlineStyles(page);
    });

    test('connect dialog open, then wallet connected', async ({ page }) => {
      await watch(page);
      await installWallets(page);
      await page.goto('/');
      await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
      const dialog = page.getByRole('dialog', { name: 'Connect wallet' });
      await expect(dialog).toBeVisible();
      await expectNoInlineStyles(page);
      await dialog.getByRole('button', { name: new RegExp(DEFAULT_WALLET.name) }).click();
      const pill = page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ });
      await expect(pill).toBeVisible();
      await expectNoInlineStyles(page);
      await pill.click();
      await expectNoInlineStyles(page);
      await page.keyboard.press('Escape');
      const network = page.getByRole('banner').getByRole('button', { name: /^Network:/ });
      // Below 640 px the network switcher lives inside the more menu (covered above).
      if (await network.isVisible()) {
        await network.click();
        await expect(network).toHaveAttribute('aria-expanded', 'true');
        await expectNoInlineStyles(page);
      }
    });
  });
}

test.describe('source', () => {
  /** Programmatic styling APIs our own code must not use (the style prop is banned by ESLint). */
  const FORBIDDEN =
    /adoptedStyleSheets|insertRule|replaceSync|new CSSStyleSheet|cssText|setAttribute\(\s*['"`]style|createElement\(\s*['"`]style|dangerouslySetInnerHTML|<style[\s>]/;

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const full = join(dir, n);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  }

  test('our code does not use CSSOM, style attributes or style elements', () => {
    const offenders = files(join(process.cwd(), 'src'))
      .filter((f) => /\.(tsx?|jsx?|mjs|css)$/.test(f))
      .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

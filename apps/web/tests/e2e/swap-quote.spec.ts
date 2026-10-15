import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  BALANCES,
  TOKENS,
  WALLET,
  answersOutliveAbort,
  deferred,
  type ApiRequest,
  type MockApi,
} from './api-mock';
import { afterRender, box, hydrated, RGB, styles } from './helpers';
import {
  ACCOUNT_B,
  DEFAULT_WALLET,
  fake,
  installWallets,
  unexpectedWalletCalls,
} from './wallet-fixture';

/**
 * The connected swap screen up to a displayed quote (ADR 0011): amounts, quote states, every error
 * code, expiry, stale answers, the data that must never be kept, accessibility and screenshots.
 * The API is answered by tests/e2e/api-mock.ts; nothing here signs or sends anything.
 */

const WIDTHS = [
  [1440, 900],
  [1200, 800],
  [768, 1024],
  [390, 844],
] as const;

const SCREENSHOTS = join(process.cwd(), '.screenshots', 'swap');

const panel = (page: Page) => page.getByRole('region', { name: 'Swap' });
const amount = (page: Page) => page.locator('#pay');
const receive = (page: Page) => page.locator('#receive');
const main = (page: Page) => page.getByRole('main');
const cta = (page: Page) => main(page).locator('button.w-cta, button[class*="w-cta"]');
const quotes = (api: MockApi): ApiRequest[] => api.calls('quotes', 'POST');
const pickerDialog = (page: Page) => page.getByRole('dialog', { name: 'Select a token' });
const rateButton = (page: Page) => main(page).getByRole('button', { name: /^Rate and fees/ });

async function open(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await hydrated(page);
}

/** Opens the swap screen with the fixture wallet connected (no quote is asked for yet). */
async function openConnected(page: Page, width = 1440, height = 900) {
  await installWallets(page);
  await open(page, width, height);
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  await page
    .getByRole('dialog', { name: 'Connect wallet' })
    .getByRole('button', { name: new RegExp(DEFAULT_WALLET.name) })
    .click();
  await expect(page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ })).toBeVisible();
  await expect(cta(page)).toHaveText('Enter an amount');
}

async function ready(page: Page, text = '0.05') {
  await amount(page).fill(text);
  await expect(cta(page)).toHaveText('Review swap');
}

/** Picks a token from the picker opened by the token button on one side. */
async function pick(page: Page, side: 'pay' | 'receive', symbol: string, chain: string) {
  await panel(page)
    .getByRole('button', { name: new RegExp(`^${side === 'pay' ? 'Pay' : 'Receive'} token:`) })
    .click();
  const dialog = pickerDialog(page);
  await dialog.getByRole('group', { name: 'Filter by chain' }).getByRole('button', { name: chain, exact: true }).click();
  await dialog.getByRole('option', { name: new RegExp(`^${symbol},`) }).click();
  await expect(dialog).toBeHidden();
}

async function shot(page: Page, name: string, width: number) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await page.screenshot({ path: join(SCREENSHOTS, `${name}-${width}.png`) });
}

test.describe('a quote is shown for a typed amount', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  test('0.05 ETH: receive amount, USD, fee, minimum, route and the button', async ({ page, api }) => {
    await ready(page);
    // Mock world: 1 ETH = $2,500, fee 0.2% of the sold amount, so 0.0499 ETH is swapped.
    await expect(receive(page)).toHaveText('124.75');
    await expect(panel(page).getByText('$124.75')).toBeVisible();
    await expect(cta(page)).toBeDisabled();
    await expect(main(page).getByText('Review and signing are not available yet.')).toBeVisible();
    await expect(main(page).getByText(/^Best of 3 routes via 0x · Expires in \d+s$/)).toBeVisible();

    await rateButton(page).click();
    const details = main(page).getByRole('heading', { name: 'Rates and fees' }).locator('..');
    await expect(details).toContainText('Ranvier fee');
    await expect(details).toContainText('0.2% · 0.0001 ETH');
    await expect(details).toContainText('Network cost (estimate)$0.31');
    await expect(details).toContainText('Minimum received124.12 USDC');
    await expect(details).toContainText('Route0x');
    await expect(details).toContainText('The fee is the exact amount signed into this quote.');
    await expect(details).toContainText('The lowest amount this quote allows, not the amount to expect.');
    await expect(details).toContainText('1 USDC = 0.0004008 ETH');
    expect(quotes(api)).toHaveLength(1);
  });
});

/** Screenshots of the main states at the four widths (looked at by hand; no pixel baselines). */
test.describe('screenshots', () => {
  const states: [
    string,
    (page: Page, api: MockApi) => Promise<void>,
  ][] = [
    [
      'ready',
      async (page) => {
        await ready(page);
        await rateButton(page).click();
      },
    ],
    [
      'loading',
      async (page, api) => {
        const gate = deferred();
        api.override((r) => (r.path === '/v1/quotes' ? { gate: gate.promise } : undefined));
        await amount(page).fill('0.05');
        await expect(cta(page)).toHaveText('Getting quote');
      },
    ],
    [
      'no-route',
      async (page, api) => {
        api.override((r) =>
          r.path === '/v1/quotes'
            ? { status: 502, json: { error: 'no_route', failures: [{ provider: '0x', error: 'no_liquidity' }] } }
            : undefined,
        );
        await amount(page).fill('0.05');
        await expect(cta(page)).toHaveText('No route found');
      },
    ],
    [
      'expired',
      async (page, api) => {
        api.quoteSettings.ttlSec = 2;
        // Every replacement is stopped too, so the screen settles on "expired".
        await ready(page);
        api.override((r) => (r.path === '/v1/quotes' ? { gate: new Promise(() => {}) } : undefined));
        await expect(cta(page)).toHaveText('Quote expired');
      },
    ],
    [
      'insufficient-balance',
      async (page) => {
        await amount(page).fill('1');
        await expect(cta(page)).toHaveText('Insufficient balance');
        await expect(receive(page)).toHaveText('2,495.00');
      },
    ],
    [
      'unsupported-pair',
      async (page) => {
        await pick(page, 'receive', 'USDC', 'Base');
        await expect(cta(page)).toHaveText('Pair not supported yet');
      },
    ],
  ];
  for (const [w, h] of WIDTHS) {
    for (const [name, step] of states) {
      test(`${name} at ${w}`, async ({ page, api }) => {
        await openConnected(page, w, h);
        await step(page, api);
        await afterRender(page);
        await shot(page, name, w);
      });
    }
  }
});

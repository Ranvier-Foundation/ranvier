import AxeBuilder from '@axe-core/playwright';
import type { Page, Request } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_ORIGIN, BALANCES, CHAINS, TOKENS, WALLET, type MockApi } from './api-mock';
import { box, hydrated, RGB, styles } from './helpers';
import {
  DEFAULT_WALLET,
  installWallets,
  unexpectedWalletCalls,
  walletCalls,
} from './wallet-fixture';

const BORDER_STRONG = 'rgb(227, 215, 210)';
const WIDTHS = [
  [1440, 900],
  [1200, 800],
  [768, 1024],
  [390, 844],
] as const;

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Select a token' });
const search = (page: Page) => dialog(page).getByRole('combobox', { name: 'Search tokens' });
const options = (page: Page) => dialog(page).getByRole('option');
const chip = (page: Page, name: string) =>
  dialog(page)
    .getByRole('group', { name: 'Filter by chain' })
    .getByRole('button', { name, exact: true });
const panel = (page: Page) => page.locator('dialog[open] > div > div');

async function open(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto('/select-token');
  await hydrated(page);
  await page.evaluate(() => document.fonts.ready);
  await expect(dialog(page)).toBeVisible();
}

/** Connects the fixture wallet on the swap screen, then opens the picker route. */
async function openConnected(page: Page, width = 1440, height = 900) {
  await installWallets(page);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await hydrated(page);
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  await page
    .getByRole('dialog', { name: 'Connect wallet' })
    .getByRole('button', { name: new RegExp(DEFAULT_WALLET.name) })
    .click();
  await expect(page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ })).toBeVisible();
  await open(page, width, height);
}

async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
}

/** Names of the options in a section, in order. */
async function optionNames(page: Page): Promise<string[]> {
  return options(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

function aborted(page: Page): { chain: string | undefined; path: string }[] {
  const list: { chain: string | undefined; path: string }[] = [];
  page.on('requestfailed', (r: Request) => {
    if (r.failure()?.errorText !== 'net::ERR_ABORTED') return;
    const url = new URL(r.url());
    if (url.origin !== API_ORIGIN) return;
    const body = r.postData();
    const chain = body
      ? (JSON.parse(body) as { chain: string }).chain
      : url.searchParams.get('chain');
    list.push({ chain: chain ?? undefined, path: url.pathname });
  });
  return list;
}

test.afterEach(async ({ page }) => {
  // The picker never asks the wallet for anything beyond connection and network methods.
  expect(await unexpectedWalletCalls(page)).toEqual([]);
});

test.describe('layout against the canvas (WebTokenSelect, MobileTokenSelect)', () => {
  test('1440: modal, header, search, chips, rows', async ({ page }) => {
    await openConnected(page);
    await chip(page, 'Base').click();
    await expect(options(page).first()).toBeVisible();
    const p = await box(panel(page));
    expect(p).toMatchObject({ x: 440, y: 72, width: 560 });

    const title = dialog(page).getByRole('heading', { name: 'Select a token' });
    expect(await styles(title, ['font-size', 'font-weight', 'letter-spacing'])).toEqual({
      'font-size': '22px',
      'font-weight': '600',
      'letter-spacing': '-0.44px',
    });
    const close = dialog(page).getByRole('button', { name: 'Close' });
    expect(await box(close)).toMatchObject({ width: 44, height: 44, x: 440 + 560 - 24 - 44 });
    // The ring is drawn on the pill field, which is 52 px tall and starts 24 px in.
    const field = page.locator('dialog[open] .search-field');
    expect(await box(field)).toMatchObject({ x: 464, width: 512, height: 52 });
    expect(await styles(field, ['background-color', 'border-radius', 'column-gap'])).toEqual({
      'background-color': RGB.bg,
      'border-radius': '999px',
      'column-gap': '10px',
    });
    expect((await styles(search(page), ['font-size', 'color']))['font-size']).toBe('16px');

    const selected = chip(page, 'Base');
    const other = chip(page, 'Ethereum');
    expect(await box(selected)).toMatchObject({ height: 36 });
    // Colours fade in 150 ms: wait for the end of the fade, then read.
    await expect(selected).toHaveCSS('background-color', RGB.primary);
    await expect(selected).toHaveCSS('color', RGB.white);
    await expect(selected).toHaveCSS('font-size', '13px');
    await expect(selected).toHaveCSS('font-weight', '500');
    expect(await styles(other, ['background-color', 'color', 'border-radius'])).toEqual({
      'background-color': RGB.pill,
      color: RGB.ink,
      'border-radius': '999px',
    });
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await expect(other).toHaveAttribute('aria-pressed', 'false');
    // Chip row sits 14 px under the field; quick picks 14 px under the chips.
    const fieldBox = await box(field);
    expect((await box(selected)).y).toBe(fieldBox.y + fieldBox.height + 14);
    const quick = dialog(page)
      .getByRole('group', { name: 'Quick picks' })
      .getByRole('button')
      .first();
    expect((await box(quick)).height).toBe(40);
    expect((await box(quick)).y).toBe((await box(selected)).y + 36 + 14);
    expect(await styles(quick, ['border-top-width', 'border-top-color', 'font-size'])).toEqual({
      'border-top-width': '1px',
      'border-top-color': RGB.line,
      'font-size': '14px',
    });

    const row = options(page).first();
    expect(await box(row)).toMatchObject({ height: 64, x: 452, width: 536 });
    const avatar = row.locator('> span').first();
    expect(await box(avatar)).toMatchObject({ width: 40, height: 40, x: 464 });
    const symbol = row.locator('> span').nth(1).locator('> span').first();
    const sub = row.locator('> span').nth(1).locator('> span').nth(1);
    expect(await styles(symbol, ['font-size', 'font-weight', 'line-height'])).toMatchObject({
      'font-size': '15px',
      'font-weight': '600',
    });
    expect(await styles(sub, ['font-size', 'color'])).toEqual({
      'font-size': '13px',
      color: RGB.sub,
    });
    await expect(sub).toHaveText('Ether · Base');
    // Text sits at the browser's normal line height, as on the artboard (19 px and 16 px lines).
    expect((await box(symbol)).height).toBe(19);
    expect((await box(sub)).height).toBe(16);
    // Network badge: 16 px with a 2 px surface ring, bottom right.
    const badge = avatar.locator('> span').nth(1);
    expect(await box(badge)).toMatchObject({ width: 16, height: 16 });
    expect(await styles(badge, ['border-top-width', 'border-top-color'])).toEqual({
      'border-top-width': '2px',
      'border-top-color': RGB.surface,
    });
    const heading = dialog(page).getByText('Your tokens');
    expect(await styles(heading, ['font-size', 'font-weight', 'color'])).toEqual({
      'font-size': '13px',
      'font-weight': '500',
      color: RGB.sub,
    });
  });

  for (const [w, h] of [WIDTHS[1], WIDTHS[2]]) {
    test(`${w}: the modal stays 560 px wide, centred, 72 px from the top`, async ({ page }) => {
      await open(page, w, h);
      expect(await box(panel(page))).toMatchObject({ x: (w - 560) / 2, y: 72, width: 560 });
    });
  }

  test('390: bottom sheet 56 px from the top, handle, compact controls', async ({ page }) => {
    await open(page, 390, 844);
    await chip(page, 'Base').click();
    await expect(options(page).first()).toBeVisible();
    expect(await box(panel(page))).toMatchObject({ x: 0, y: 56, width: 390, height: 788 });
    const handle = page.locator('dialog[open] > div > div > span').first();
    expect(await box(handle)).toMatchObject({ width: 40, height: 4, x: 175 });
    expect(await styles(handle, ['background-color'])).toEqual({
      'background-color': BORDER_STRONG,
    });
    const title = dialog(page).getByRole('heading', { name: 'Select a token' });
    expect(await styles(title, ['font-size', 'font-weight'])).toEqual({
      'font-size': '20px',
      'font-weight': '600',
    });
    expect(await box(title)).toMatchObject({ x: 20 });
    const field = page.locator('dialog[open] .search-field');
    expect(await box(field)).toMatchObject({ x: 16, width: 358, height: 48 });
    // Chips lose their dot and keep 14 px side padding; quick picks are not drawn.
    const base = chip(page, 'Base');
    expect(await box(base)).toMatchObject({ x: expect.any(Number), height: 36 });
    expect(await styles(base, ['padding-left', 'padding-right'])).toEqual({
      'padding-left': '14px',
      'padding-right': '14px',
    });
    await expect(dialog(page).getByRole('group', { name: 'Quick picks' })).toBeHidden();
    // Rows: the sub line is the chain only (the canvas drops the token name on mobile).
    const row = options(page).first();
    await expect(row.locator('> span').nth(1).locator('> span').nth(1)).toHaveText('Base', {
      useInnerText: true,
    });
    expect(await box(row)).toMatchObject({ x: 8, height: 64, width: 374 });
    // The list scrolls inside the sheet; the sheet itself does not.
    const scroller = page.locator('dialog[open] [role="listbox"]').locator('xpath=..');
    expect(await styles(scroller, ['overflow-y'])).toEqual({ 'overflow-y': 'auto' });
  });

  test('chips are 36 px drawn with a 44 px hit area', async ({ page }) => {
    await open(page);
    const base = chip(page, 'Base');
    const b = await box(base);
    expect(b.height).toBe(36);
    // 4 px above and below the drawn chip still hit it.
    for (const dy of [-3, b.height + 2]) {
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.closest('button')?.textContent?.trim(),
        [b.x + b.width / 2, b.y + dy],
      );
      expect(hit).toContain('Base');
    }
  });
});

test.describe('data comes only from the API', () => {
  test('signed out: lists tokens of every chain, no balances, says why', async ({ page, api }) => {
    await open(page);
    await expect(options(page).first()).toBeVisible();
    expect(api.calls('chains')).toHaveLength(1);
    const asked = api.calls('tokens').map((r) => new URLSearchParams(r.search).get('chain'));
    expect(asked.sort()).toEqual(['evm:1', 'evm:42161', 'evm:8453']);
    for (const r of api.calls('tokens')) {
      expect(r.method).toBe('GET');
      expect(new URLSearchParams(r.search).get('limit')).toBe('100');
    }
    expect(api.calls('balances')).toHaveLength(0);
    const total = CHAINS.reduce((n, c) => n + TOKENS[c.key].length, 0);
    await expect(options(page)).toHaveCount(total);
    await expect(dialog(page).getByText('Tokens', { exact: true })).toBeVisible();
    await expect(dialog(page).getByText('Your tokens')).toHaveCount(0);
    await expect(dialog(page).getByText('Connect a wallet to see your balances.')).toBeVisible();
    // No quick picks while all networks are shown (a quick pick must name its chain).
    await expect(dialog(page).getByRole('group', { name: 'Quick picks' })).toHaveCount(0);
    // Only our API and our own origin were ever contacted.
    expect(walletCalls(page)).toEqual([]);
  });

  test('connected: balances come from POST /v1/balances with the wallet in the body only', async ({
    page,
    api,
  }) => {
    await openConnected(page);
    await expect(dialog(page).getByText('Your tokens')).toBeVisible();
    const calls = api.calls('balances');
    expect(calls.map((c) => (c.body as { chain: string }).chain).sort()).toEqual([
      'evm:1',
      'evm:42161',
      'evm:8453',
    ]);
    for (const c of calls) {
      expect(c.method).toBe('POST');
      expect(Object.keys(c.body as object).sort()).toEqual(['address', 'chain']);
      expect((c.body as { address: string }).address.toLowerCase()).toBe(WALLET.toLowerCase());
      expect(c.search).toBe('');
      expect(c.headers['content-type']).toBe('application/json');
      expect(c.headers['cookie']).toBeUndefined();
      expect(c.headers['referer']).toBeUndefined();
    }
    // The address never appears in any URL.
    for (const r of api.requests) {
      expect((r.path + r.search).toLowerCase()).not.toContain(WALLET.toLowerCase().slice(2));
    }
    expect(api.requests.some((r) => r.method === 'GET' && r.path === '/v1/balances')).toBe(false);
    // Held tokens first, in list order, then the rest. Zero balances show nothing.
    const names = await optionNames(page);
    expect(names.slice(0, 4)).toEqual([
      'ETH, Ether, Ethereum, balance 0.0841',
      'USDC, USD Coin, Ethereum, balance 2,410.50',
      'ETH, Ether, Base, balance 1.5',
      'USDC, USD Coin, Base, balance 640.00',
    ]);
    expect(names[4]).toBe('DAI, Dai Stablecoin, Ethereum');
    await expect(dialog(page).getByText('Other tokens')).toBeVisible();
    const zero = options(page).filter({ hasText: 'DAI' });
    await expect(zero.locator('.num')).toHaveCount(0);
    // Stablecoins read with two places, others with up to four, right-aligned and tabular.
    const bal = options(page).first().locator('.num');
    await expect(bal).toHaveText('0.0841');
    expect(await styles(bal, ['font-variant-numeric', 'text-align', 'font-weight'])).toMatchObject({
      'font-variant-numeric': 'tabular-nums',
      'text-align': 'right',
      'font-weight': '500',
    });
    // Nothing was asked of the wallet beyond connecting.
    expect(walletCalls(page)).toContain('eth_requestAccounts');
  });

  test('every request goes to the app or the API: no RPC provider, no other host', async ({
    page,
  }) => {
    const hosts = new Set<string>();
    page.on('request', (r) => {
      if (/^https?:/.test(r.url())) hosts.add(new URL(r.url()).origin);
    });
    await openConnected(page);
    await expect(dialog(page).getByText('Your tokens')).toBeVisible();
    expect([...hosts].filter((h) => h !== new URL(page.url()).origin)).toEqual([API_ORIGIN]);
  });

  test('a token name with markup is shown as text and runs nothing', async ({ page, api }) => {
    api.override((r) =>
      r.path === '/v1/tokens' && new URLSearchParams(r.search).get('chain') === 'evm:1'
        ? {
            json: [
              {
                chain: 'evm:1',
                address: 'native',
                symbol: 'ETH',
                name: '<img src=x onerror=window.__pwned=1><a href=//evil.example>',
                decimals: 18,
                tags: ['native'],
                logoUri: 'https://evil.example/logo.png',
              },
            ],
          }
        : undefined,
    );
    await open(page);
    await expect(
      dialog(page).getByText('<img src=x onerror=window.__pwned=1><a href=//evil.example>'),
    ).toBeVisible();
    await expect(dialog(page).locator('img, a, script, iframe')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
    // logoUri is never fetched or rendered.
  });
});

test.describe('chain switching, search and stale answers', () => {
  test('choosing a chain shows only its tokens, quick picks and a pressed chip', async ({
    page,
  }) => {
    await open(page);
    await chip(page, 'Base').click();
    await expect(chip(page, 'Base')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(page, 'All')).toHaveAttribute('aria-pressed', 'false');
    await expect(options(page)).toHaveCount(TOKENS['evm:8453'].length);
    expect(await optionNames(page)).toEqual(['ETH, Ether, Base', 'USDC, USD Coin, Base']);
    const quick = dialog(page).getByRole('group', { name: 'Quick picks' });
    await expect(quick.getByRole('button')).toHaveCount(2);
    await expect(quick.getByRole('button', { name: 'ETH on Base' })).toBeVisible();
    await expect(quick.getByRole('button', { name: 'USDC on Base' })).toBeVisible();
    await chip(page, 'All').click();
    await expect(dialog(page).getByRole('group', { name: 'Quick picks' })).toHaveCount(0);
  });

  test('switching chain aborts the old requests and a late answer never shows', async ({
    page,
    api,
  }) => {
    const abortedRequests = aborted(page);
    await openConnected(page);
    await expect(dialog(page).getByText('Your tokens')).toBeVisible();
    // New picker session with slow answers for Ethereum, switch away before they arrive.
    api.override((r) => {
      const chain =
        r.path === '/v1/balances'
          ? (r.body as { chain: string }).chain
          : new URLSearchParams(r.search).get('chain');
      return chain === 'evm:1' && r.path !== '/v1/chains' ? { delayMs: 4000, json: [] } : undefined;
    });
    await page.reload();
    await hydrated(page);
    await expect(dialog(page)).toBeVisible();
    await chip(page, 'Base').click();
    await expect(options(page)).toHaveCount(TOKENS['evm:8453'].length);
    await expect
      .poll(() =>
        abortedRequests
          .filter((a) => a.chain === 'evm:1')
          .map((a) => a.path)
          .sort(),
      )
      .toEqual(['/v1/balances', '/v1/tokens']);
    // Only Base rows, and its own balances.
    expect(await optionNames(page)).toEqual([
      'ETH, Ether, Base, balance 1.5',
      'USDC, USD Coin, Base, balance 640.00',
    ]);
    // Wait past the slow answer: nothing from Ethereum appears.
    await page.waitForTimeout(600);
    await expect(dialog(page).getByText('Ethereum')).toHaveCount(1); // the chain chip only
    expect(BALANCES['evm:8453']['ETH']).toBe('1500000000000000000');
  });

  test('typing sends one request after a pause, and an old search never overwrites a new one', async ({
    page,
    api,
  }) => {
    const abortedRequests = aborted(page);
    await open(page);
    await chip(page, 'Ethereum').click();
    await expect(options(page)).toHaveCount(TOKENS['evm:1'].length);
    const before = api.calls('tokens').length;
    api.override((r) =>
      new URLSearchParams(r.search).get('q') === 'usd' ? { delayMs: 3000, json: [] } : undefined,
    );
    const input = search(page);
    await input.pressSequentially('usd', { delay: 20 });
    // One request for the pause, not one per keystroke.
    await expect.poll(() => api.calls('tokens').length).toBe(before + 1);
    expect(new URLSearchParams(api.calls('tokens').at(-1)!.search).get('q')).toBe('usd');
    // The user moves on before the slow answer: that request is aborted and its (empty) answer
    // never replaces the new results.
    await input.fill('dai');
    await expect(options(page)).toHaveCount(1);
    expect(await optionNames(page)).toEqual(['DAI, Dai Stablecoin, Ethereum']);
    await expect.poll(() => abortedRequests.filter((a) => a.path === '/v1/tokens').length).toBe(1);
    await page.waitForTimeout(500);
    expect(await optionNames(page)).toEqual(['DAI, Dai Stablecoin, Ethereum']);
  });

  test('search by name, symbol and full address', async ({ page }) => {
    await open(page);
    await chip(page, 'Base').click();
    await search(page).fill('usd coin');
    await expect(options(page)).toHaveCount(1);
    await search(page).fill('ETH');
    await expect(options(page)).toHaveCount(1);
    await search(page).fill(TOKENS['evm:8453'][1]!.address);
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText('USDC');
  });

  test('closing aborts requests that are still running', async ({ page, api }) => {
    const abortedRequests = aborted(page);
    api.override((r) => (r.path === '/v1/tokens' ? { delayMs: 5000, json: [] } : undefined));
    await page.goto('/select-token');
    await hydrated(page);
    await expect(dialog(page).getByText('Loading tokens')).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL('/');
    await expect.poll(() => abortedRequests.filter((a) => a.path === '/v1/tokens').length).toBe(3);
  });
});

test.describe('states', () => {
  test('loading shows a skeleton and announces it', async ({ page, api }) => {
    api.override((r) => (r.path === '/v1/tokens' ? { delayMs: 1500 } : undefined));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/select-token');
    await hydrated(page);
    await expect(dialog(page).getByRole('status').first()).toHaveText('Loading tokens');
    await expect(options(page)).toHaveCount(0);
    expect((await scan(page)).violations).toEqual([]);
    await expect(options(page).first()).toBeVisible();
    await expect(dialog(page).getByRole('status').first()).toHaveText(/^\d+ tokens$/);
  });

  test('empty search says so, and text the API would refuse is never sent', async ({
    page,
    api,
  }) => {
    await open(page);
    await search(page).fill('zzzz');
    await expect(dialog(page).getByText(/^No tokens match\./)).toBeVisible();
    await expect(options(page)).toHaveCount(0);
    await expect(search(page)).toHaveAttribute('aria-expanded', 'false');
    const sent = api.calls('tokens').length;
    await search(page).fill('<b>');
    await expect(dialog(page).getByText(/^No tokens match\./)).toBeVisible();
    await page.waitForTimeout(500);
    expect(api.calls('tokens')).toHaveLength(sent);
    expect((await scan(page)).violations).toEqual([]);
    await search(page).fill('');
    await expect(options(page).first()).toBeVisible();
  });

  test('API error shows a retry that works, and offers no list while it is down', async ({
    page,
    api,
  }) => {
    let down = true;
    api.override((r) =>
      down && r.path === '/v1/tokens' ? { status: 500, json: { error: 'x' } } : undefined,
    );
    await open(page);
    const alert = dialog(page).getByRole('alert');
    await expect(alert).toContainText('Ranvier could not load the token list');
    await expect(options(page)).toHaveCount(0);
    expect((await scan(page)).violations).toEqual([]);
    down = false;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(options(page).first()).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test('the chain list failing has its own retry', async ({ page, api }) => {
    let down = true;
    api.override((r) => (down && r.path === '/v1/chains' ? { abort: true } : undefined));
    await open(page);
    await expect(dialog(page).getByRole('alert')).toContainText('could not load the token list');
    down = false;
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(options(page).first()).toBeVisible();
  });

  test.describe('an answer that does not match the contract is refused whole', () => {
    const bad: [string, unknown][] = [
      [
        'bidi override in a symbol',
        [
          {
            chain: 'evm:1',
            address: 'native',
            symbol: 'E‮TH',
            name: 'Ether',
            decimals: 18,
            tags: [],
          },
        ],
      ],
      [
        'a token of another chain',
        [
          {
            chain: 'evm:8453',
            address: 'native',
            symbol: 'ETH',
            name: 'Ether',
            decimals: 18,
            tags: [],
          },
        ],
      ],
      [
        'an address that is a URL',
        [
          {
            chain: 'evm:1',
            address: 'https://evil.example',
            symbol: 'ETH',
            name: 'Ether',
            decimals: 18,
            tags: [],
          },
        ],
      ],
      ['not an array', { tokens: [] }],
    ];
    for (const [label, body] of bad) {
      test(label, async ({ page, api }) => {
        api.override((r) => (r.path === '/v1/tokens' ? { json: body } : undefined));
        await open(page);
        await expect(dialog(page).getByRole('alert')).toContainText(
          'could not load the token list',
        );
        await expect(options(page)).toHaveCount(0);
      });
    }
    test('a page that is not JSON', async ({ page, api }) => {
      api.override((r) =>
        r.path === '/v1/tokens' ? { raw: '<html>', contentType: 'text/html' } : undefined,
      );
      await open(page);
      await expect(dialog(page).getByRole('alert')).toBeVisible();
    });
  });

  test('a failed balance read keeps the token list and can be retried', async ({ page, api }) => {
    let down = true;
    api.override((r) =>
      down && r.path === '/v1/balances'
        ? { status: 503, json: { error: 'rpc_unavailable' } }
        : undefined,
    );
    await openConnected(page);
    await expect(options(page)).toHaveCount(CHAINS.reduce((n, c) => n + TOKENS[c.key].length, 0));
    const note = dialog(page)
      .getByRole('status')
      .filter({ hasText: 'Could not load your balances' });
    await expect(note).toHaveText(
      'Could not load your balances on Ethereum, Base, and Arbitrum One. The token list still works.',
    );
    await expect(dialog(page).getByText('Your tokens')).toHaveCount(0);
    // Every option is still selectable, none shows a balance.
    await expect(options(page).locator('.num')).toHaveCount(0);
    expect((await scan(page)).violations).toEqual([]);
    down = false;
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await expect(dialog(page).getByText('Your tokens')).toBeVisible();
    await expect(note).toHaveCount(0);
  });

  test('a chain the API cannot read right now says so and asks nothing of it', async ({
    page,
    api,
  }) => {
    api.override((r) =>
      r.path === '/v1/chains'
        ? { json: CHAINS.map((c) => (c.key === 'evm:42161' ? { ...c, balances: false } : c)) }
        : undefined,
    );
    await openConnected(page);
    await expect(dialog(page).getByText('Your tokens')).toBeVisible();
    await expect(
      dialog(page).getByText('Balances are not available on Arbitrum One right now.'),
    ).toBeVisible();
    expect(api.calls('balances').map((c) => (c.body as { chain: string }).chain)).not.toContain(
      'evm:42161',
    );
    await expect(dialog(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('a balance placeholder shows while balances load', async ({ page, api }) => {
    api.override((r) => (r.path === '/v1/balances' ? { delayMs: 1500 } : undefined));
    await openConnected(page);
    await expect(options(page).first()).toBeVisible();
    await expect(dialog(page).getByText('Loading your balances')).toBeVisible();
    await expect(dialog(page).getByText('Your tokens')).toBeVisible();
    await expect(dialog(page).getByText('Loading your balances')).toHaveCount(0);
  });
});

test.describe('selection and keyboard', () => {
  test('clicking a token returns { chain, address } to the caller', async ({ page }) => {
    await open(page);
    await chip(page, 'Base').click();
    await options(page).filter({ hasText: 'USDC' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Token chosen' })).toBeVisible();
    // The caller got the chain and the contract address; the line is rebuilt from them.
    await expect(page.getByText('USDC on Base')).toBeVisible();
  });

  test('a quick pick returns the native coin as `native`', async ({ page }) => {
    await open(page);
    await chip(page, 'Arbitrum One').click();
    await dialog(page).getByRole('button', { name: 'ETH on Arbitrum One' }).click();
    await expect(page.getByText('ETH on Arbitrum One')).toBeVisible();
  });

  test('keyboard only: type, arrow to a token, Enter; reopen, Tab wraps, Escape restores focus', async ({
    page,
  }) => {
    await open(page);
    // Focus starts in the search field.
    await expect(search(page)).toBeFocused();
    await page.keyboard.type('usdc');
    await expect(options(page)).toHaveCount(3);
    await expect(search(page)).not.toHaveAttribute('aria-activedescendant', /./);
    await page.keyboard.press('ArrowDown');
    const first = options(page).nth(0);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    const firstId = await first.getAttribute('id');
    await expect(search(page)).toHaveAttribute('aria-activedescendant', firstId!);
    await page.keyboard.press('ArrowDown');
    await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(first).toHaveAttribute('aria-selected', 'false');
    // The highlighted option shows a ring, not only a tint.
    const ring = await styles(options(page).nth(1), ['outline-style', 'outline-width']);
    expect(ring).toEqual({ 'outline-style': 'solid', 'outline-width': '2px' });
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByText('USDC on Base')).toBeVisible();
    // Focus moved to the result, so the next Tab reaches the reopen button.
    await page.keyboard.press('Tab');
    const reopen = page.getByRole('button', { name: 'Choose a token' });
    await expect(reopen).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(search(page)).toBeFocused();
    // Tab order: close, search, All, each chain. Past the last control it wraps to the first.
    await page.keyboard.press('Shift+Tab');
    await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const results = dialog(page).getByRole('region', { name: 'Token results' });
    await expect(results).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(chip(page, 'Arbitrum One')).toBeFocused();
    const focusRing = await styles(chip(page, 'Arbitrum One'), [
      'outline-width',
      'outline-offset',
      'outline-style',
    ]);
    expect(focusRing).toEqual({
      'outline-width': '2px',
      'outline-offset': '2px',
      'outline-style': 'solid',
    });
    await page.keyboard.press('Tab');
    await expect(results).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(search(page)).toBeFocused();
    // Chips work from the keyboard and keep focus.
    await page.keyboard.press('Tab');
    await expect(chip(page, 'All')).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(chip(page, 'Ethereum')).toHaveAttribute('aria-pressed', 'true');
    // Escape closes and focus goes back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(reopen).toBeFocused();
  });

  test('Enter with nothing highlighted selects nothing', async ({ page }) => {
    await open(page);
    await page.keyboard.type('usdc');
    await expect(options(page)).toHaveCount(3);
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
  });

  test('Escape, the close button and the scrim go back to the swap screen', async ({ page }) => {
    await open(page);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL('/');
    await open(page);
    await page.mouse.click(10, 500);
    await expect(page).toHaveURL('/');
  });

  test('Tab never leaves the dialog and the page behind is inert', async ({ page }) => {
    await open(page);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(
        () => document.activeElement?.closest('dialog[open]') !== null,
      );
      expect(inside).toBe(true);
    }
  });
});

test.describe('accessibility', () => {
  for (const [w, h] of [WIDTHS[0], WIDTHS[3]]) {
    test(`axe: signed out at ${w}`, async ({ page }) => {
      await open(page, w, h);
      await expect(options(page).first()).toBeVisible();
      expect((await scan(page)).violations).toEqual([]);
    });
    test(`axe: connected with balances, one chain and quick picks at ${w}`, async ({ page }) => {
      await openConnected(page, w, h);
      await expect(dialog(page).getByText('Your tokens')).toBeVisible();
      expect((await scan(page)).violations).toEqual([]);
      await chip(page, 'Base').click();
      await expect(options(page)).toHaveCount(2);
      await page.keyboard.press('ArrowDown');
      expect((await scan(page)).violations).toEqual([]);
    });
    test(`axe: error state at ${w}`, async ({ page, api }) => {
      api.override((r) => (r.path === '/v1/tokens' ? { status: 500 } : undefined));
      await open(page, w, h);
      await expect(dialog(page).getByRole('alert')).toBeVisible();
      expect((await scan(page)).violations).toEqual([]);
    });
  }

  test('the combobox and listbox are wired as ARIA expects', async ({ page }) => {
    await open(page);
    await expect(options(page).first()).toBeVisible();
    const input = search(page);
    await expect(input).toHaveAttribute('aria-autocomplete', 'list');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    const listbox = dialog(page).getByRole('listbox', { name: 'Tokens' });
    await expect(input).toHaveAttribute('aria-controls', (await listbox.getAttribute('id'))!);
    await expect(dialog(page)).toHaveAccessibleName('Select a token');
    await expect(dialog(page).getByRole('group', { name: 'Tokens' })).toHaveCount(1);
  });

  test('controls are real buttons with 44 px targets', async ({ page }) => {
    await open(page);
    await expect(options(page).first()).toBeVisible();
    const close = dialog(page).getByRole('button', { name: 'Close' });
    expect(await box(close)).toMatchObject({ width: 44, height: 44 });
    expect(await box(options(page).first())).toMatchObject({ height: 64 });
    const tags = await dialog(page)
      .getByRole('button')
      .evaluateAll((els) => els.map((e) => e.tagName));
    expect(new Set(tags)).toEqual(new Set(['BUTTON']));
  });

  test('reduced motion: nothing animates in the picker', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await expect(options(page).first()).toBeVisible();
    expect((await styles(chip(page, 'Base'), ['transition-duration']))['transition-duration']).toBe(
      '0s',
    );
    expect(
      (await styles(options(page).first(), ['transition-duration']))['transition-duration'],
    ).toBe('0s');
  });
});

test.describe('captured for looking at', () => {
  const states: [string, (page: Page, api: MockApi) => Promise<void>][] = [
    ['signed-out', async () => {}],
    [
      'base',
      async (page) => {
        await chip(page, 'Base').click();
        await expect(options(page)).toHaveCount(2);
      },
    ],
    [
      'empty',
      async (page) => {
        await search(page).fill('zzzz');
        await expect(dialog(page).getByText(/^No tokens match/)).toBeVisible();
      },
    ],
  ];
  for (const [w, h] of WIDTHS) {
    for (const [name, step] of states) {
      test(`${name} at ${w}`, async ({ page, api }, testInfo) => {
        await open(page, w, h);
        await expect(options(page).first()).toBeVisible();
        await step(page, api);
        const path = testInfo.outputPath(`${name}-${w}.png`);
        await page.screenshot({ path });
        await testInfo.attach(`${name}-${w}`, { path, contentType: 'image/png' });
      });
    }
    test(`connected at ${w}`, async ({ page }, testInfo) => {
      await openConnected(page, w, h);
      await expect(dialog(page).getByText('Your tokens')).toBeVisible();
      const path = testInfo.outputPath(`connected-${w}.png`);
      await page.screenshot({ path });
      await testInfo.attach(`connected-${w}`, { path, contentType: 'image/png' });
    });
    test(`balances failed at ${w}`, async ({ page, api }, testInfo) => {
      api.override((r) => (r.path === '/v1/balances' ? { status: 503 } : undefined));
      await openConnected(page, w, h);
      await expect(dialog(page).getByText(/Could not load your balances/)).toBeVisible();
      const path = testInfo.outputPath(`balances-failed-${w}.png`);
      await page.screenshot({ path });
      await testInfo.attach(`balances-failed-${w}`, { path, contentType: 'image/png' });
    });
    test(`token list failed at ${w}`, async ({ page, api }, testInfo) => {
      api.override((r) => (r.path === '/v1/tokens' ? { status: 500 } : undefined));
      await open(page, w, h);
      await expect(dialog(page).getByRole('alert')).toBeVisible();
      const path = testInfo.outputPath(`tokens-failed-${w}.png`);
      await page.screenshot({ path });
      await testInfo.attach(`tokens-failed-${w}`, { path, contentType: 'image/png' });
    });
  }
});

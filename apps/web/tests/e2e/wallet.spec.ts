import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { getAddress } from 'viem';
import { box, gotoSwap, RGB, styles } from './helpers';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  DEFAULT_WALLET,
  ICON_PNG,
  fake,
  installHostileAnnouncements,
  installWallets,
  walletCalls,
  ALLOWED_WALLET_METHODS,
  type FakeWalletSpec,
} from './wallet-fixture';

const CHECKSUMMED_A = getAddress(ACCOUNT_A);
const SHORT_A = `${CHECKSUMMED_A.slice(0, 6)}…${CHECKSUMMED_A.slice(-4)}`;
/** Nav targets whose screens do not exist yet; Next prefetches them and gets a 404. */
const UNBUILT_ROUTES = new Set([
  '/trade',
  '/buy',
  '/activity',
  '/portfolio',
  '/account',
  '/notifications',
  '/select-token',
  '/settings',
]);
const header = (page: Page) => page.getByRole('banner');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Connect wallet' });
const walletPill = (page: Page) => header(page).getByRole('button', { name: /^Wallet 0x/ });
const connectButton = (page: Page) => header(page).getByRole('button', { name: 'Connect wallet' });

async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
}

/** Connects through the dialog with the default fixture wallet. */
async function connect(page: Page) {
  await connectButton(page).click();
  await dialog(page)
    .getByRole('button', { name: new RegExp(DEFAULT_WALLET.name) })
    .click();
  await expect(walletPill(page)).toBeVisible();
}

// Collected for every test: nothing may leave the origin, nothing may log an error.
const problems = new WeakMap<Page, string[]>();
test.beforeEach(({ page, baseURL }) => {
  const list: string[] = [];
  problems.set(page, list);
  const origin = new URL(baseURL ?? 'http://127.0.0.1:3100').origin;
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return;
    if (url.origin !== origin) list.push(`third-party request: ${r.url()}`);
  });
  page.on('console', (m) => {
    // 404s are checked on the response below (unbuilt nav routes are prefetched).
    if (m.type() === 'error' && !/Failed to load resource.*404/.test(m.text())) {
      list.push(`console error: ${m.text()}`);
    }
  });
  page.on('response', (r) => {
    const { pathname } = new URL(r.url());
    if (r.status() >= 400 && !UNBUILT_ROUTES.has(pathname)) list.push(`${r.status()} ${r.url()}`);
  });
  page.on('pageerror', (e) => list.push(`page error: ${e.message}`));
});
test.afterEach(({ page }) => {
  expect(problems.get(page)).toEqual([]);
  // Allowlist, for every test and across reloads: nothing but connection and network methods.
  expect(walletCalls(page).filter((m) => !ALLOWED_WALLET_METHODS.has(m))).toEqual([]);
});

test.describe('connect dialog without a wallet', () => {
  test('shows an honest empty state, no fake wallet, and closes with Escape', async ({ page }) => {
    await gotoSwap(page, 1440, 900);
    await connectButton(page).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.getByText('No browser wallet found')).toBeVisible();
    await expect(d.getByText(/Install a browser wallet extension/)).toBeVisible();
    // Only the disabled coming-soon rows exist as buttons besides Close.
    const names = await d
      .getByRole('button')
      .evaluateAll((els) => els.map((e) => e.textContent?.trim() || e.getAttribute('aria-label')));
    expect(names).toEqual(['Close', 'PPhone walletComing soon', 'SSolana walletsComing soon']);
    expect((await scan(page)).violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(connectButton(page)).toBeFocused();
  });
});

test.describe('connect flow', () => {
  test.beforeEach(async ({ page }) => {
    await installWallets(page);
  });

  test('lists the announced wallet, connects, closes, shows the connected state', async ({
    page,
  }) => {
    await gotoSwap(page, 1440, 900);
    await connectButton(page).click();
    const d = dialog(page);
    const row = d.getByRole('button', { name: /Fixture Wallet/ });
    await expect(row).toBeVisible();
    await expect(row.locator('img')).toHaveAttribute('src', ICON_PNG);
    expect((await scan(page)).violations).toEqual([]);
    await row.click();
    await expect(d).toBeHidden();
    await expect(walletPill(page)).toHaveAccessibleName(`Wallet ${SHORT_A}`);
    await expect(walletPill(page)).toBeFocused();
    await expect(connectButton(page)).toHaveCount(0);
    // Swap CTA: disabled "Enter an amount".
    const cta = page.getByRole('main').getByRole('button', { name: 'Enter an amount' });
    await expect(cta).toBeDisabled();
    expect(await styles(cta, ['opacity', 'cursor'])).toEqual({
      opacity: '0.5',
      cursor: 'not-allowed',
    });
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Connect wallet' }),
    ).toHaveCount(0);
    // The page never asked for a signature or a transaction, nor read chain data itself.
    // The allowlist itself is enforced in afterEach; here: the log really records the connect.
    expect(walletCalls(page)).toContain('eth_requestAccounts');
  });

  test('the swap CTA opens the same dialog and focus returns to it', async ({ page }) => {
    await gotoSwap(page, 1440, 900);
    const cta = page.getByRole('main').getByRole('button', { name: 'Connect wallet' });
    await cta.click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(cta).toBeFocused();
  });

  test('user rejection shows a plain message and a working retry', async ({ page }) => {
    await gotoSwap(page, 1440, 900);
    await fake(page, (w) => (w.__fake.connect = 'reject'));
    await connectButton(page).click();
    const d = dialog(page);
    await d.getByRole('button', { name: /Fixture Wallet/ }).click();
    await expect(d.getByRole('alert')).toContainText(
      'You declined the request in Fixture Wallet. Nothing was connected.',
    );
    expect((await scan(page)).violations).toEqual([]);
    await fake(page, (w) => (w.__fake.connect = 'ok'));
    await d.getByRole('button', { name: 'Try again' }).click();
    await expect(d).toBeHidden();
    await expect(walletPill(page)).toBeVisible();
  });

  test('a pending request and a generic failure each say what to do', async ({ page }) => {
    await gotoSwap(page, 1440, 900);
    await connectButton(page).click();
    const d = dialog(page);
    await fake(page, (w) => (w.__fake.connect = 'pending'));
    await d.getByRole('button', { name: /Fixture Wallet/ }).click();
    await expect(d.getByRole('alert')).toContainText('already has a request open');
    await fake(page, (w) => (w.__fake.connect = 'fail'));
    await d.getByRole('button', { name: 'Try again' }).click();
    await expect(d.getByRole('alert')).toContainText(
      'Could not connect to Fixture Wallet. Unlock it',
    );
    // The wallet's own error text ("boom") is never shown.
    await expect(d).not.toContainText('boom');
  });

  test('persists across a reload without a hydration error, and the server HTML has no address', async ({
    page,
    request,
  }) => {
    await gotoSwap(page, 1440, 900);
    await connect(page);
    await page.reload();
    await expect(walletPill(page)).toBeVisible();
    const html = await (await request.get('/')).text();
    expect(html).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(html).not.toContain('0x7a3E');
    const stored = await page.evaluate(() => Object.keys(localStorage));
    expect(stored.every((k) => k.startsWith('wagmi.'))).toBe(true);
  });

  test('disconnect from the wallet menu, and it stays disconnected after a reload', async ({
    page,
  }) => {
    await gotoSwap(page, 1440, 900);
    await connect(page);
    await walletPill(page).click();
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(connectButton(page)).toBeVisible();
    await expect(
      page.getByRole('main').getByRole('button', { name: 'Connect wallet' }),
    ).toBeVisible();
    await page.reload();
    await expect(connectButton(page)).toBeVisible();
    await expect(walletPill(page)).toHaveCount(0);
  });

  test('wallet menu: copy with confirmation, explorer link for the chain, axe', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await gotoSwap(page, 1440, 900);
    await connect(page);
    await walletPill(page).click();
    const menu = page.locator('#' + (await walletPill(page).getAttribute('aria-controls')));
    await expect(menu.getByText(CHECKSUMMED_A)).toBeVisible();
    const link = menu.getByRole('link', { name: /View on explorer/ });
    await expect(link).toHaveAttribute('href', `https://etherscan.io/address/${CHECKSUMMED_A}`);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect((await scan(page)).violations).toEqual([]);
    await menu.getByRole('button', { name: 'Copy address' }).click();
    await expect(menu.getByRole('status')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CHECKSUMMED_A);
    await page.keyboard.press('Escape');
    await expect(walletPill(page)).toBeFocused();
    await expect(menu).toBeHidden();
  });

  test('a second authorised account shows +1', async ({ page }) => {
    await page.addInitScript(
      ({ a, b }) => {
        (window as unknown as { __fake: { accounts: string[] } }).__fake.accounts = [a, b];
      },
      { a: ACCOUNT_A, b: ACCOUNT_B },
    );
    await gotoSwap(page, 1440, 900);
    await connect(page);
    await expect(walletPill(page)).toHaveAccessibleName(`Wallet ${SHORT_A} and 1 more`);
    await expect(walletPill(page)).toContainText('+1');
  });

  test('accountsChanged updates the pill; an empty list disconnects', async ({ page }) => {
    await gotoSwap(page, 1440, 900);
    await connect(page);
    await fake(page, (w) =>
      w.__emit('accountsChanged', ['0x2222222222222222222222222222222222223333']),
    );
    await expect(walletPill(page)).toHaveAccessibleName('Wallet 0x2222…3333');
    await fake(page, (w) => w.__emit('accountsChanged', []));
    await expect(connectButton(page)).toBeVisible();
  });

  test('network menu switches chains; rejection and an unknown chain keep the old one', async ({
    page,
  }) => {
    await gotoSwap(page, 1440, 900);
    await connect(page);
    const net = header(page).getByRole('button', { name: /^Network:/ });
    await expect(net).toHaveAccessibleName('Network: Ethereum');
    await net.click();
    const menu = page.locator('#' + (await net.getAttribute('aria-controls')));
    await expect(menu.getByRole('button', { name: /Ethereum/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect((await scan(page)).violations).toEqual([]);
    await fake(page, (w) => (w.__fake.switch = 'reject'));
    await menu.getByRole('button', { name: /Base/ }).click();
    await expect(menu.getByRole('alert')).toContainText('You declined the switch in your wallet');
    await expect(net).toHaveAccessibleName('Network: Ethereum');
    await fake(page, (w) => (w.__fake.switch = 'ok'));
    await menu.getByRole('button', { name: /Base/ }).click();
    await expect(net).toHaveAccessibleName('Network: Base');
    await expect(menu).toBeHidden();
    // A chain the wallet does not know answers 4902; the pill keeps the current network.
    await net.click();
    await fake(page, (w) => (w.__fake.unknown = ['0xa4b1']));
    await menu.getByRole('button', { name: /Arbitrum One/ }).click();
    await expect(menu.getByRole('alert')).toContainText('could not switch to Arbitrum One');
    await expect(net).toHaveAccessibleName('Network: Base');
  });

  test('a chain the wallet adds that Ranvier does not list shows Unsupported network', async ({
    page,
  }) => {
    await gotoSwap(page, 1440, 900);
    await connect(page);
    await fake(page, (w) => w.__emit('chainChanged', '0x89'));
    const net = header(page).getByRole('button', { name: 'Network: unsupported, switch network' });
    await expect(net).toContainText('Unsupported network');
    await net.click();
    const menu = page.locator('#' + (await net.getAttribute('aria-controls')));
    await expect(menu).toContainText('does not support');
    expect((await scan(page)).violations).toEqual([]);
    await fake(page, (w) => (w.__fake.chainId = '0x1'));
    await menu.getByRole('button', { name: 'Switch to Ethereum' }).click();
    await expect(header(page).getByRole('button', { name: 'Network: Ethereum' })).toBeVisible();
  });

  test('keyboard: open, trap focus, connect with Enter, focus lands on the wallet pill', async ({
    page,
  }) => {
    await gotoSwap(page, 1440, 900);
    await connectButton(page).focus();
    await page.keyboard.press('Enter');
    const d = dialog(page);
    await expect(d).toBeVisible();
    const inside = () =>
      page.evaluate(
        () => document.querySelector('dialog')?.contains(document.activeElement) ?? false,
      );
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await inside()).toBe(true);
    }
    await d.getByRole('button', { name: /Fixture Wallet/ }).focus();
    await page.keyboard.press('Enter');
    await expect(d).toBeHidden();
    await expect(walletPill(page)).toBeFocused();
  });
});

test.describe('untrusted wallet announcements', () => {
  test('bad icons are dropped, names are cleaned, duplicates and extras are capped', async ({
    page,
  }) => {
    const many: FakeWalletSpec[] = [
      { name: 'Evil‮ Wallet\u0000', rdns: 'evil.one', icon: 'javascript:alert(1)' },
      {
        name: 'Svg Wallet',
        rdns: 'svg.wallet',
        icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      },
      { name: 'Html Icon', rdns: 'html.icon', icon: 'data:text/html;base64,PGgxPg==' },
      { name: 'Remote Icon', rdns: 'remote.icon', icon: 'https://evil.example/x.png' },
      { name: 'Duplicate', rdns: 'svg.wallet', icon: ICON_PNG },
      { name: '<img src=x onerror=alert(1)>', rdns: 'html.name', icon: ICON_PNG },
      { name: 'Bad Rdns', rdns: 'no spaces allowed!', icon: ICON_PNG },
      { name: `Aaa${'x'.repeat(197)}`, rdns: 'long.name', icon: ICON_PNG },
      ...Array.from({ length: 12 }, (_, i) => ({
        name: `Extra ${i}`,
        rdns: `extra.w${i}`,
        icon: ICON_PNG,
      })),
    ];
    await installWallets(page, many);
    await gotoSwap(page, 1440, 900);
    await connectButton(page).click();
    const d = dialog(page);
    const rows = d.locator('ul').first().getByRole('button');
    // Eight real wallets at most, plus the disabled phone row.
    await expect(rows).toHaveCount(9);
    const srcs = await d
      .locator('img')
      .evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''));
    expect(srcs.every((s) => /^data:image\/(png|svg\+xml|webp);base64,/.test(s))).toBe(true);
    await expect(d).not.toContainText('Bad Rdns');
    await expect(d).not.toContainText('‮');
    const html = await d.innerHTML();
    expect(html).not.toContain('<img src=x');
    await expect(d.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(html).not.toMatch(/evil\.example|javascript:/);
    expect(html).toContain(`Aaa${'x'.repeat(37)}<`);
    expect(html).not.toContain('x'.repeat(38));
    expect((await scan(page)).violations).toEqual([]);
  });
});

test.describe('hostile announcements', () => {
  test('objects that change between reads never reach an img src or a request', async ({
    page,
  }) => {
    await installHostileAnnouncements(page);
    await gotoSwap(page, 1440, 900);
    await connectButton(page).click();
    const d = dialog(page);
    await expect(d.getByRole('button', { name: /Plain Good/ })).toBeVisible();
    const srcs = await page
      .locator('img')
      .evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''));
    expect(srcs.length).toBeGreaterThan(0);
    expect(srcs.every((s) => s.startsWith('data:image/png;base64,'))).toBe(true);
    // Whatever was listed, no row text or attribute carries the attacker's URL.
    expect(await d.innerHTML()).not.toMatch(/evil\.example|evil\.rdns/);
    // Allow any pending image load to start before the afterEach checks for off-origin requests.
    await page.waitForTimeout(300);
    expect((await scan(page)).violations).toEqual([]);
  });
});

test.describe('look-alike wallets', () => {
  test('same-named wallets show their rdns, unique names do not', async ({ page }) => {
    await installWallets(page, [
      { name: 'Impostor', rdns: 'io.metamask', icon: ICON_PNG },
      { name: 'MetaMask', rdns: 'io.metamask.fake', icon: ICON_PNG },
      { name: 'metamask', rdns: 'io.metamask.other', icon: ICON_PNG },
      { name: 'Solo Wallet', rdns: 'solo.wallet', icon: ICON_PNG },
    ]);
    await gotoSwap(page, 1440, 900);
    await connectButton(page).click();
    const d = dialog(page);
    await expect(d.getByRole('button', { name: /MetaMask.*io\.metamask\.fake/ })).toBeVisible();
    await expect(d.getByRole('button', { name: /metamask.*io\.metamask\.other/ })).toBeVisible();
    const solo = d.getByRole('button', { name: /Solo Wallet/ });
    await expect(solo).toBeVisible();
    await expect(solo).not.toContainText('solo.wallet');
    await expect(d.getByRole('button', { name: /Impostor/ })).not.toContainText('io.metamask');
    await page.screenshot({ path: test.info().outputPath('lookalike-1440.png') });
    expect((await scan(page)).violations).toEqual([]);
  });
});

test.describe('geometry against the canvas', () => {
  test('1440: header controls 44px, avatar 30px, dialog 640 wide, 96 from the top', async ({
    page,
  }) => {
    await installWallets(page);
    await gotoSwap(page, 1440, 900);
    await connectButton(page).click();
    const d = dialog(page);
    const panel = d.locator('> div > div');
    const p = await box(panel);
    expect([p.width, p.y]).toEqual([640, 96]);
    expect(p.x).toBe(400);
    const head = await box(d.getByRole('heading', { name: 'Connect wallet' }));
    expect(head.x - p.x).toBe(24);
    expect(
      await styles(d.getByRole('heading', { name: 'Connect wallet' }), [
        'font-size',
        'font-weight',
      ]),
    ).toEqual({ 'font-size': '22px', 'font-weight': '600' });
    const close = await box(d.getByRole('button', { name: 'Close' }));
    expect([close.width, close.height]).toEqual([44, 44]);
    expect(p.x + p.width - (close.x + close.width)).toBe(24);
    const row = await box(d.getByRole('button', { name: /Fixture Wallet/ }));
    expect(row.height).toBeGreaterThanOrEqual(56);
    const icon = await box(
      d
        .getByRole('button', { name: /Fixture Wallet/ })
        .locator('span')
        .first(),
    );
    expect([icon.width, icon.height]).toEqual([36, 36]);
    expect(
      (
        await styles(
          d
            .getByRole('button', { name: /Fixture Wallet/ })
            .locator('span')
            .first(),
          ['border-top-left-radius'],
        )
      )['border-top-left-radius'],
    ).toBe('10px');
    expect((await styles(panel, ['background-color']))['background-color']).toBe(RGB.surface);
    await d.getByRole('button', { name: /Fixture Wallet/ }).click();
    const pill = await box(walletPill(page));
    expect(pill.height).toBe(44);
    const avatar = await box(walletPill(page).locator('span').first());
    expect([avatar.width, avatar.height]).toEqual([30, 30]);
    expect(
      await styles(walletPill(page), ['background-color', 'border-top-left-radius', 'font-size']),
    ).toEqual({
      'background-color': RGB.pill,
      'border-top-left-radius': '999px',
      'font-size': '15px',
    });
    expect(
      (await styles(walletPill(page).locator('.addr'), ['font-feature-settings']))[
        'font-feature-settings'
      ],
    ).toContain('"zero"');
    const net = await box(header(page).getByRole('button', { name: /^Network:/ }));
    expect(net.height).toBe(44);
  });

  test('390: the dialog is a bottom sheet, 56px from the top at most, full width', async ({
    page,
  }) => {
    await installWallets(page);
    await gotoSwap(page, 390, 844);
    await header(page).getByRole('button', { name: 'Connect wallet' }).click();
    const panel = dialog(page).locator('> div > div');
    const p = await box(panel);
    expect([p.x, p.width]).toEqual([0, 390]);
    expect(p.y).toBeGreaterThanOrEqual(56);
    expect(Math.round(p.y + p.height)).toBe(844);
    const close = await box(dialog(page).getByRole('button', { name: 'Close' }));
    expect([close.width, close.height]).toEqual([44, 44]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    expect((await scan(page)).violations).toEqual([]);
  });
});

test.describe('connected header at every width', () => {
  for (const [width, height] of [
    [1440, 900],
    [1200, 800],
    [768, 1024],
    [390, 844],
  ] as const) {
    test(`one line, flush right, wallet reachable at ${width}`, async ({ page }, testInfo) => {
      await installWallets(page);
      await gotoSwap(page, width, height);
      await connect(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const h = header(page);
      const more = await box(h.getByRole('button', { name: 'More' }));
      expect(Math.abs(more.x + more.width - (width - 20))).toBeLessThanOrEqual(1);
      const hb = await box(h);
      for (const b of await h.getByRole('button').all()) {
        if (!(await b.isVisible())) continue;
        const bb = await box(b);
        expect(bb.height).toBe(44);
        expect(bb.y).toBeGreaterThanOrEqual(hb.y);
        expect(bb.y + bb.height).toBeLessThanOrEqual(hb.y + hb.height);
      }
      const pill = await box(walletPill(page));
      expect(pill.x + pill.width).toBeLessThanOrEqual(more.x);
      const logo = await box(h.getByRole('link', { name: 'Ranvier home' }));
      expect(pill.x).toBeGreaterThanOrEqual(logo.x + logo.width);
      if (width < 640) {
        // The network switcher lives in the more menu.
        await expect(h.getByRole('button', { name: /^Network:/ })).toBeHidden();
        await h.getByRole('button', { name: 'More' }).click();
        const group = h.getByRole('group', { name: 'Switch network' });
        await expect(group.getByRole('button', { name: /Base/ })).toBeVisible();
        expect((await scan(page)).violations).toEqual([]);
        await group.getByRole('button', { name: /Base/ }).click();
        await expect(group.getByRole('button', { name: /Base/ })).toHaveAttribute(
          'aria-current',
          'true',
        );
      }
      await page.screenshot({ path: testInfo.outputPath(`connected-${width}.png`) });
      await testInfo.attach(`connected-${width}`, {
        path: testInfo.outputPath(`connected-${width}.png`),
        contentType: 'image/png',
      });
    });
    test(`dialog open at ${width}`, async ({ page }, testInfo) => {
      await installWallets(page);
      await gotoSwap(page, width, height);
      await connectButton(page).click();
      await expect(dialog(page)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`dialog-${width}.png`) });
      await testInfo.attach(`dialog-${width}`, {
        path: testInfo.outputPath(`dialog-${width}.png`),
        contentType: 'image/png',
      });
    });
  }
});

test.describe('states, captured for review', () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`menus and error states at ${width}`, async ({ page }, testInfo) => {
      await installWallets(page);
      await gotoSwap(page, width, height);
      const shot = async (name: string) => {
        const path = testInfo.outputPath(`${name}-${width}.png`);
        await page.screenshot({ path });
        await testInfo.attach(`${name}-${width}`, { path, contentType: 'image/png' });
      };
      await fake(page, (w) => (w.__fake.connect = 'reject'));
      await connectButton(page).click();
      await dialog(page)
        .getByRole('button', { name: /Fixture Wallet/ })
        .click();
      await expect(dialog(page).getByRole('alert')).toBeVisible();
      await shot('dialog-rejected');
      await fake(page, (w) => (w.__fake.connect = 'ok'));
      await dialog(page).getByRole('button', { name: 'Try again' }).click();
      await expect(walletPill(page)).toBeVisible();
      await walletPill(page).click();
      await shot('wallet-menu');
      await page.keyboard.press('Escape');
      await fake(page, (w) => w.__emit('chainChanged', '0x89'));
      if (width >= 640) {
        await header(page)
          .getByRole('button', { name: /^Network:/ })
          .click();
      } else {
        await header(page).getByRole('button', { name: 'More' }).click();
      }
      await shot('network-unsupported');
    });
  }
});

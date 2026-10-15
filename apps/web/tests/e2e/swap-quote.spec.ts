import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  CHAINS,
  TOKENS,
  WALLET,
  answersOutliveAbort,
  balancesAnswer,
  deferred,
  type ApiRequest,
  type MockApi,
  type QuoteSettings,
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
  await dialog
    .getByRole('group', { name: 'Filter by chain' })
    .getByRole('button', { name: chain, exact: true })
    .click();
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

  test('0.05 ETH: receive amount, USD, fee, minimum, route and the button', async ({
    page,
    api,
  }) => {
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
    await expect(details).toContainText(
      'The lowest amount this quote allows, not the amount to expect.',
    );
    await expect(details).toContainText('1 USDC = 0.0004008 ETH');
    expect(quotes(api)).toHaveLength(1);
  });
});

const SECRETS = [
  'ROUTERCALLDATA',
  'SIGNEDSWAPCALLDATA',
  'SIGNATUREDONOTKEEP',
  'SECRETCALLDATAHASH',
  'FEEWRAPPERADDRESS',
  'Uniswap_V3',
  '123456789',
];

const note = (page: Page) => main(page).locator('[id$="-note"]');
const status = (page: Page) => page.getByRole('status', { name: 'Quote status' });

test.describe('what is sent and what is kept', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  test('the request has the documented body, goes to the API origin only, and the wallet is in the body only', async ({
    page,
    api,
  }) => {
    await ready(page);
    const [req] = quotes(api);
    expect(req!.method).toBe('POST');
    expect(req!.path).toBe('/v1/quotes');
    expect(req!.search).toBe('');
    expect(req!.body).toEqual({
      sellToken: { chain: 'evm:1', address: 'native' },
      buyToken: { chain: 'evm:1', address: TOKENS['evm:1'][1]!.address },
      sellAmount: '50000000000000000',
      taker: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      slippageBps: 50,
    });
    expect((req!.body as { taker: string }).taker.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(req!.headers['content-type']).toBe('application/json');
    expect(req!.headers['cookie']).toBeUndefined();
    expect(req!.headers['authorization']).toBeUndefined();
    expect(req!.headers['referer']).toBeUndefined();
    for (const r of api.requests) {
      expect((r.path + r.search).toLowerCase()).not.toContain(WALLET.toLowerCase().slice(2));
    }
    // The wallet was asked for nothing beyond connecting (no signing, no sending).
    expect(await unexpectedWalletCalls(page)).toEqual([]);
  });

  test('calldata, signature and the signed transaction are not on the page, in storage or in the console', async ({
    page,
  }) => {
    const logged: string[] = [];
    page.on('console', (m) => logged.push(m.text()));
    await ready(page);
    await rateButton(page).click();
    const dump = await page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      text: document.body.innerText,
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
      name: window.name,
      url: location.href,
    }));
    for (const secret of SECRETS) {
      for (const [where, value] of Object.entries(dump)) {
        expect(value, `${secret} in ${where}`).not.toContain(secret);
      }
      expect(logged.join('\n')).not.toContain(secret);
    }
    // Nothing of the answer is in a form field or a link either.
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('[href],[src],input')].map(
          (e) => e.getAttribute('href') ?? e.getAttribute('src') ?? (e as HTMLInputElement).value,
        ),
      ),
    ).not.toContain(expect.stringContaining('0x00000000000'));
  });

  test('text from the answer is shown as text: a provider name that looks like markup', async ({
    page,
    api,
  }) => {
    api.quoteSettings.tamper = (answer) => {
      (answer['best'] as { provider: string }).provider = '<img src=x onerror=alert(1)>';
    };
    await ready(page);
    await expect(
      main(page).getByText(/Best of 3 routes via <img src=x onerror=alert\(1\)>/),
    ).toBeVisible();
    await expect(page.locator('main img')).toHaveCount(0);
  });
});

test.describe('typing an amount', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  test('ignores what is not an amount and keeps the rest', async ({ page, api }) => {
    await amount(page).pressSequentially('1a.-e5,');
    await expect(amount(page)).toHaveValue('1.5');
    await expect(cta(page)).toHaveText(/Insufficient balance|Getting quote|Review swap/);
    await expect.poll(() => quotes(api).length).toBe(1);
    expect((quotes(api)[0]!.body as { sellAmount: string }).sellAmount).toBe('1500000000000000000');
  });

  test('typing fast asks once, for the amount the person stopped on', async ({ page, api }) => {
    await amount(page).pressSequentially('0.0123', { delay: 30 });
    await expect(cta(page)).toHaveText('Review swap');
    expect(quotes(api).map((r) => (r.body as { sellAmount: string }).sellAmount)).toEqual([
      '12300000000000000',
    ]);
  });

  test('takes a pasted amount with thousands separators', async ({ page }) => {
    await amount(page).fill('1,000.5');
    await expect(amount(page)).toHaveValue('1000.5');
  });

  test('refuses text that is too long and keeps what was there', async ({ page }) => {
    await amount(page).fill('12');
    await amount(page).fill('9'.repeat(81));
    await expect(amount(page)).toHaveValue('12');
  });

  test('a huge amount is "too large" and nothing is asked', async ({ page, api }) => {
    await amount(page).fill('9'.repeat(78));
    await expect(cta(page)).toHaveText('Amount too large');
    await expect(note(page)).toContainText('Enter a smaller amount.');
    expect(quotes(api)).toHaveLength(0);
  });

  test('zero is not an amount', async ({ page, api }) => {
    for (const text of ['0', '0.000', '.']) {
      await amount(page).fill(text);
      await expect(cta(page)).toHaveText('Enter an amount');
    }
    await expect(panel(page).getByText('$0.00').first()).toBeVisible();
    expect(quotes(api)).toHaveLength(0);
  });

  test('one wei is asked for as it is; the answer decides ("no route")', async ({ page, api }) => {
    api.override((r) =>
      r.path === '/v1/quotes'
        ? {
            status: 502,
            json: { error: 'no_route', failures: [{ provider: '0x', error: 'no_liquidity' }] },
          }
        : undefined,
    );
    await amount(page).fill('0.000000000000000001');
    await expect(cta(page)).toHaveText('No route found');
    expect((quotes(api)[0]!.body as { sellAmount: string }).sellAmount).toBe('1');
    await expect(note(page)).toContainText('Try a different amount or token.');
  });

  test('clearing the amount drops the quote and stops the request', async ({ page, api }) => {
    await ready(page);
    await amount(page).fill('');
    await expect(cta(page)).toHaveText('Enter an amount');
    await expect(receive(page)).toHaveText('0');
    await expect(main(page).getByText(/Best of/)).toHaveCount(0);
    await expect(rateButton(page)).toHaveCount(0);
    expect(quotes(api)).toHaveLength(1);
  });

  test('a pay token with 6 decimals ignores the seventh decimal', async ({ page }) => {
    await pick(page, 'pay', 'USDC', 'Ethereum'); // the other side's token: the two swap places
    await expect(
      panel(page).getByRole('button', { name: 'Pay token: USDC, change' }),
    ).toBeVisible();
    await expect(
      panel(page).getByRole('button', { name: 'Receive token: ETH, change' }),
    ).toBeVisible();
    await amount(page).pressSequentially('0.1234567');
    await expect(amount(page)).toHaveValue('0.123456');
  });
});

test.describe('tokens and pairs', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  test('opens on ETH to USDC on Ethereum, from the registry', async ({ page }) => {
    await expect(panel(page).locator('label[for=pay]')).toHaveText('Pay on Ethereum');
    await expect(panel(page).locator('label[for=receive]')).toHaveText('Receive on Ethereum');
    await expect(panel(page).getByRole('button', { name: 'Pay token: ETH, change' })).toBeVisible();
    await expect(
      panel(page).getByRole('button', { name: 'Receive token: USDC, change' }),
    ).toBeVisible();
  });

  test('a token chosen in the picker is quoted; the picker returns the token and closes', async ({
    page,
    api,
  }) => {
    await pick(page, 'receive', 'DAI', 'Ethereum');
    await expect(
      panel(page).getByRole('button', { name: 'Receive token: DAI, change' }),
    ).toBeFocused();
    await ready(page);
    expect((quotes(api)[0]!.body as { buyToken: unknown }).buyToken).toEqual({
      chain: 'evm:1',
      address: '0x6b175474e89094c44da98b954eedeac495271d0f',
    });
    // 18 decimals: 124.75 DAI with two places, as for any stablecoin.
    await expect(receive(page)).toHaveText('124.75');
  });

  test('flip swaps the two tokens, pays what the quote gave, and asks again', async ({
    page,
    api,
  }) => {
    await ready(page);
    await panel(page).getByRole('button', { name: 'Switch pay and receive' }).click();
    await expect(
      panel(page).getByRole('button', { name: 'Pay token: USDC, change' }),
    ).toBeVisible();
    await expect(amount(page)).toHaveValue('124.75');
    await expect.poll(() => quotes(api).length).toBe(2);
    expect(quotes(api)[1]!.body).toMatchObject({
      sellToken: { chain: 'evm:1', address: TOKENS['evm:1'][1]!.address },
      buyToken: { chain: 'evm:1', address: 'native' },
      sellAmount: '124750000',
    });
    await expect(cta(page)).toHaveText('Review swap');
  });

  test('a pair on two chains is "not supported yet": said at once, nothing asked', async ({
    page,
    api,
  }) => {
    await pick(page, 'receive', 'USDC', 'Base');
    await expect(cta(page)).toHaveText('Pair not supported yet');
    await expect(note(page)).toHaveText(
      'Swaps between Ethereum and Base are not supported yet. Choose two tokens on the same network.',
    );
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Pair not supported yet');
    expect(quotes(api)).toHaveLength(0);
    // Back to one chain: the quote comes.
    await pick(page, 'receive', 'USDC', 'Ethereum');
    await expect(cta(page)).toHaveText('Review swap');
  });

  test('a token this build does not list leaves the side empty: "select a token"', async ({
    page,
    api,
  }) => {
    api.override((r) => {
      if (r.path !== '/v1/tokens') return undefined;
      const chain = new URLSearchParams(r.search).get('chain') as keyof typeof TOKENS;
      const rows = TOKENS[chain] ?? [];
      if (chain !== 'evm:1') return { json: rows };
      return {
        json: [
          ...rows,
          {
            chain: 'evm:1',
            address: '0x1111111111111111111111111111111111110001',
            symbol: 'NEWT',
            name: 'New Token',
            decimals: 18,
            tags: [],
          },
        ],
      };
    });
    await panel(page)
      .getByRole('button', { name: /^Receive token:/ })
      .click();
    await pickerDialog(page)
      .getByRole('option', { name: /^NEWT,/ })
      .click();
    await expect(cta(page)).toHaveText('Select a token');
    await expect(note(page)).toContainText('not listed in this version of Ranvier');
    await expect(
      panel(page).getByRole('button', { name: 'Receive token: none selected, choose one' }),
    ).toBeVisible();
    await amount(page).fill('0.05');
    expect(quotes(api)).toHaveLength(0);
    // Choosing a listed token puts it right.
    await pick(page, 'receive', 'USDC', 'Ethereum');
    await expect(cta(page)).toHaveText('Review swap');
  });

  test('wrapping is a direct 1 to 1 quote: free, no routing and no countdown', async ({
    page,
    api,
  }) => {
    await pick(page, 'receive', 'WETH', 'Ethereum');
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Review swap');
    await expect(receive(page)).toHaveText('0.05');
    await expect(main(page).getByText('Wrap, 1 to 1, no routing needed')).toBeVisible();
    await expect(main(page).getByText(/Expires in/)).toHaveCount(0);
    await rateButton(page).click();
    const details = main(page).getByRole('heading', { name: 'Rates and fees' }).locator('..');
    await expect(details).toContainText('Ranvier feeFree');
    await expect(details).toContainText('Wrapping and unwrapping is free.');
    await expect(details).not.toContainText('Network cost');
    await expect(details).not.toContainText('signed into this quote');
    // Nothing runs out: a long wait asks nothing more.
    await page.waitForTimeout(1_500);
    expect(quotes(api)).toHaveLength(1);
  });
});

test.describe('a chain the API cannot quote on', () => {
  test('is "network unavailable": said before an amount, nothing asked', async ({ page, api }) => {
    api.override((r) =>
      r.path === '/v1/chains'
        ? { json: CHAINS.map((c) => (c.key === 'evm:1' ? { ...c, quoting: false } : c)) }
        : undefined,
    );
    await installWallets(page);
    await open(page);
    await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
    await page
      .getByRole('dialog', { name: 'Connect wallet' })
      .getByRole('button', { name: new RegExp(DEFAULT_WALLET.name) })
      .click();
    await expect(cta(page)).toHaveText('Network unavailable');
    await expect(note(page)).toHaveText('Swaps on Ethereum are not available right now.');
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Network unavailable');
    expect(quotes(api)).toHaveLength(0);
  });
});

test.describe('fees come from the quote', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  const details = (page: Page): Locator =>
    main(page).getByRole('heading', { name: 'Rates and fees' }).locator('..');

  test('the schedule tier is named from the shared fee schedule, not typed', async ({ page }) => {
    await ready(page);
    await rateButton(page).click();
    await expect(details(page)).toContainText('Rate for swap size: Under $10,000.');
  });

  test('the first-swap waiver is its own line, with the amount the API waived', async ({
    page,
    api,
  }) => {
    api.quoteSettings.firstSwap = true;
    await ready(page);
    await rateButton(page).click();
    await expect(details(page)).toContainText('Ranvier feeFree');
    // 0.05 ETH is $125.00 in the mock's world: all of it is waived.
    await expect(details(page)).toContainText('First swap waiver$125.00');
    await expect(details(page)).toContainText('First swap: $125.00 of this swap is free.');
  });

  test('above the waiver the fee is charged on the rest, and the waiver line shows the cap', async ({
    page,
    api,
  }) => {
    api.override((r) =>
      r.path === '/v1/balances'
        ? { json: balancesAnswer('evm:1', WALLET, { ETH: '10000000000000000000' }) }
        : undefined,
    );
    api.quoteSettings.firstSwap = true;
    await ready(page, '1');
    await rateButton(page).click();
    // $2,500 swap: $1,000 is waived, 0.2% of the rest (0.6 ETH) is 0.0012 ETH.
    await expect(details(page)).toContainText('0.2% · 0.0012 ETH');
    await expect(details(page)).toContainText('First swap waiver$1,000.00');
  });

  test('a stablecoin pair shows the stablecoin rate and reason', async ({ page }) => {
    await pick(page, 'pay', 'USDC', 'Ethereum');
    await pick(page, 'receive', 'DAI', 'Ethereum');
    await ready(page, '100');
    await rateButton(page).click();
    await expect(details(page)).toContainText('0.05% · 0.05 USDC');
    await expect(details(page)).toContainText('Rate for a stablecoin to stablecoin swap.');
  });

  test('an answer with a fee the schedule cannot produce is refused whole', async ({
    page,
    api,
  }) => {
    api.quoteSettings.tamper = (answer) => {
      (answer['fee'] as { bps: number }).bps = 31;
    };
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
    await expect(receive(page)).toHaveText('0');
    await expect(main(page).getByText(/Best of/)).toHaveCount(0);
  });

  test('an answer for another wallet is refused whole', async ({ page, api }) => {
    api.quoteSettings.tamper = (answer) => {
      (answer['swap'] as { quote: { user: string } }).quote.user = ACCOUNT_B.toLowerCase();
    };
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
    await expect(receive(page)).toHaveText('0');
  });

  test('the minimum received is labelled as a floor, not a promise', async ({ page }) => {
    await ready(page);
    await rateButton(page).click();
    await expect(details(page)).toContainText('Minimum received124.12 USDC');
    await expect(details(page)).toContainText(
      'The lowest amount this quote allows, not the amount to expect.',
    );
  });
});

test.describe('every error the API can answer, in calm words', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  const cases: [string, number, unknown, string, string][] = [
    [
      'no route',
      502,
      { error: 'no_route', failures: [{ provider: '0x', error: 'no_liquidity' }] },
      'No route found',
      'No route found for this amount. Try a different amount or token.',
    ],
    [
      'no route because every provider was slow',
      502,
      { error: 'no_route', failures: [{ provider: '0x', error: 'timeout' }] },
      'Quote unavailable',
      'Routing is slow right now. Try again in a moment.',
    ],
    [
      'price unavailable',
      503,
      { error: 'price_unavailable' },
      'Price unavailable',
      'Ranvier could not check the price of one of these tokens. Try again in a moment.',
    ],
    [
      'routing unavailable',
      503,
      { error: 'routing_unavailable', message: 'No routing providers are configured' },
      'Routing unavailable',
      'Routing is not available right now. Try again in a moment.',
    ],
    [
      'signing unavailable',
      503,
      { error: 'signing_unavailable' },
      'Quote unavailable',
      'Ranvier cannot prepare a quote right now. Try again in a moment.',
    ],
    [
      'an internal error',
      500,
      { error: 'internal_error' },
      'Quote unavailable',
      'Ranvier could not get a quote. Try again in a moment.',
    ],
    [
      'an invalid request',
      400,
      { error: 'invalid_request', fields: ['sellToken.address'] },
      'Quote unavailable',
      'Ranvier could not get a quote. Try again in a moment.',
    ],
    [
      'a bad gateway with no body',
      502,
      undefined,
      'Quote unavailable',
      'Ranvier could not get a quote. Try again in a moment.',
    ],
  ];
  for (const [name, statusCode, body, label, text] of cases) {
    test(name, async ({ page, api }) => {
      api.override((r) =>
        r.path === '/v1/quotes'
          ? body === undefined
            ? { status: statusCode, raw: '<html>bad gateway</html>', contentType: 'text/html' }
            : { status: statusCode, json: body }
          : undefined,
      );
      await amount(page).fill('0.05');
      await expect(cta(page)).toHaveText(label);
      await expect(note(page)).toContainText(text);
      await expect(receive(page)).toHaveText('0');
      // The page never shows what the API said beyond the stable code's own copy.
      await expect(page.getByText('No routing providers are configured')).toHaveCount(0);
      // Nothing is asked again by itself.
      await page.waitForTimeout(600);
      expect(quotes(api)).toHaveLength(1);
    });
  }

  test('an answer that is not JSON, and one that is not a quote, are "unavailable"', async ({
    page,
    api,
  }) => {
    api.override((r) =>
      r.path === '/v1/quotes' ? { raw: '<html>', contentType: 'text/html' } : undefined,
    );
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
    api.override((r) => (r.path === '/v1/quotes' ? { json: { hello: 'world' } } : undefined));
    await amount(page).fill('0.06');
    await expect(cta(page)).toHaveText('Quote unavailable');
  });

  test('a network failure: "could not be reached", and "try again" recovers', async ({
    page,
    api,
  }) => {
    api.override((r) => (r.path === '/v1/quotes' ? { abort: true } : undefined));
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
    await expect(note(page)).toContainText('Ranvier could not be reached. Check your connection');
    api.clearOverrides(); // the API is back
    await note(page).getByRole('button', { name: 'Try again' }).click();
    await expect(cta(page)).toHaveText('Review swap');
  });

  test('offline says so', async ({ page, api }) => {
    // The routed API answers even when the browser is offline, so the failure and the browser's
    // own offline flag are both set by hand.
    api.override((r) => (r.path === '/v1/quotes' ? { abort: true } : undefined));
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }),
    );
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
    await expect(note(page)).toContainText('You are offline. Reconnect, then try again.');
    api.clearOverrides();
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }),
    );
    await note(page).getByRole('button', { name: 'Try again' }).click();
    await expect(cta(page)).toHaveText('Review swap');
  });

  test('"try again" is not offered where it cannot help (no route)', async ({ page, api }) => {
    api.override((r) =>
      r.path === '/v1/quotes'
        ? { status: 502, json: { error: 'no_route', failures: [] } }
        : undefined,
    );
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('No route found');
    await expect(note(page).getByRole('button')).toHaveCount(0);
  });
});

test.describe('balances are display only', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  test('too little balance says so, honestly, and the quote is still asked for and shown', async ({
    page,
    api,
  }) => {
    await amount(page).fill('1');
    await expect(cta(page)).toHaveText('Insufficient balance');
    await expect(note(page)).toContainText(
      'Your last balance read on Ethereum was 0.0841 ETH, below this amount. Balances can be out of date.',
    );
    // The quote is asked for although the balance is low, and its numbers are on screen.
    await expect(receive(page)).toHaveText('2,495.00');
    expect(quotes(api)).toHaveLength(1);
    // Reading again picks up a balance that has grown.
    api.override((r) =>
      r.path === '/v1/balances'
        ? { json: balancesAnswer('evm:1', WALLET, { ETH: '2000000000000000000' }) }
        : undefined,
    );
    await note(page).getByRole('button', { name: 'Read balance again' }).click();
    await expect(cta(page)).toHaveText('Review swap');
  });

  test('a failed balance read blocks nothing', async ({ page, api }) => {
    api.override((r) =>
      r.path === '/v1/balances' ? { status: 503, json: { error: 'rpc_unavailable' } } : undefined,
    );
    await amount(page).fill('1');
    await expect(cta(page)).toHaveText('Review swap');
    expect(api.calls('balances').length).toBeGreaterThanOrEqual(1);
  });

  test('the balance is read only once an amount is typed, and only for the pay chain', async ({
    page,
    api,
  }) => {
    expect(api.calls('balances')).toHaveLength(0);
    await amount(page).fill('0.01');
    await expect(cta(page)).toHaveText('Review swap');
    expect(api.calls('balances').map((r) => (r.body as { chain: string }).chain)).toEqual([
      'evm:1',
    ]);
  });
});

test.describe('late answers and changes mid-quote', () => {
  test('a slow answer for an old amount never replaces the newer quote', async ({ page, api }) => {
    const late = await answersOutliveAbort(page);
    const first = deferred();
    let n = 0;
    api.override((r) =>
      r.path === '/v1/quotes' && n++ === 0 ? { gate: first.promise } : undefined,
    );
    await openConnected(page);
    await amount(page).fill('0.05');
    await expect.poll(() => quotes(api).length).toBe(1);
    await amount(page).fill('0.01');
    await expect(cta(page)).toHaveText('Review swap');
    await expect(receive(page)).toHaveText('24.95');
    const before = await late.count();
    first.release();
    await late.until(before + 1);
    await afterRender(page);
    await expect(receive(page)).toHaveText('24.95');
    await expect(amount(page)).toHaveValue('0.01');
  });

  test('a wallet switched mid-quote: the old wallet answer is dropped and the new wallet is quoted', async ({
    page,
    api,
  }) => {
    const late = await answersOutliveAbort(page);
    const first = deferred();
    let n = 0;
    api.override((r) =>
      r.path === '/v1/quotes' && n++ === 0 ? { gate: first.promise } : undefined,
    );
    await openConnected(page);
    await amount(page).fill('0.05');
    await expect.poll(() => quotes(api).length).toBe(1);
    await fake(page, (w) =>
      w.__emit('accountsChanged', ['0x1111111111111111111111111111111111112222']),
    );
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Wallet 0x1111…2222' }),
    ).toBeVisible();
    await expect.poll(() => quotes(api).length).toBe(2);
    expect((quotes(api)[1]!.body as { taker: string }).taker.toLowerCase()).toBe(
      '0x1111111111111111111111111111111111112222',
    );
    await expect(cta(page)).toHaveText('Review swap');
    const before = await late.count();
    first.release();
    await late.until(before + 1);
    await afterRender(page);
    await expect(cta(page)).toHaveText('Review swap');
    await expect(receive(page)).toHaveText('124.75');
    // The first wallet's address never reached the console or a URL (the shared checks also run).
    expect(
      api.requests
        .filter((r) => r.method === 'GET')
        .every((r) => !r.search.includes(WALLET.slice(2))),
    ).toBe(true);
  });

  test('a wallet disconnected mid-quote: the quote goes, nothing more is asked, a late answer is ignored', async ({
    page,
    api,
  }) => {
    const late = await answersOutliveAbort(page);
    const first = deferred();
    api.override((r) => (r.path === '/v1/quotes' ? { gate: first.promise } : undefined));
    await openConnected(page);
    await amount(page).fill('0.05');
    await expect.poll(() => quotes(api).length).toBe(1);
    await fake(page, (w) => w.__emit('accountsChanged', []));
    await expect(main(page).getByRole('button', { name: 'Connect wallet' })).toBeVisible();
    const before = await late.count();
    first.release();
    await late.until(before + 1);
    await afterRender(page);
    await expect(receive(page)).toHaveText('0');
    await expect(main(page).getByRole('button', { name: 'Connect wallet' })).toBeVisible();
    await expect(main(page).getByText(/Best of/)).toHaveCount(0);
    expect(quotes(api)).toHaveLength(1);
  });

  test('a wallet that switches network keeps the quote: the quote does not depend on it', async ({
    page,
    api,
  }) => {
    await openConnected(page);
    await ready(page);
    await fake(page, (w) => w.__emit('chainChanged', '0x2105'));
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Network: Base' }),
    ).toBeVisible();
    await page.waitForTimeout(600);
    await expect(cta(page)).toHaveText('Review swap');
    await expect(panel(page).locator('label[for=pay]')).toHaveText('Pay on Ethereum');
    expect(quotes(api)).toHaveLength(1);
  });
});

test.describe('the answer must be for the chain and time that were asked (ADR 0012)', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  /** Echo fields replaced by the test, or removed (`undefined`), and what is moved off by one. */
  const swapCases: [string, Pick<QuoteSettings, 'echo' | 'deadlineOffsetSec'>][] = [
    ['a sellChain of another chain', { echo: { sellChain: 'evm:8453' } }],
    ['a buyChain of another chain', { echo: { buyChain: 'evm:8453' } }],
    ['a chainId of another chain', { echo: { chainId: 8453 } }],
    ['a chainId that is the right number as text', { echo: { chainId: '1' } }],
    ['no sellChain', { echo: { sellChain: undefined } }],
    ['no buyChain', { echo: { buyChain: undefined } }],
    ['no chainId', { echo: { chainId: undefined } }],
    ['no serverTime', { echo: { serverTime: undefined } }],
    ['no ttlSeconds', { echo: { ttlSeconds: undefined } }],
    ['a serverTime that is not a number', { echo: { serverTime: 'now' } }],
    ['a serverTime that does not add up to the deadline', { echo: { serverTime: 1_700_000_000 } }],
    ['a ttlSeconds that is not a number', { echo: { ttlSeconds: '60' } }],
    ['a deadline one second late', { deadlineOffsetSec: 1 }],
    ['a deadline one second early', { deadlineOffsetSec: -1 }],
  ];

  for (const [name, settings] of swapCases) {
    test(`an answer with ${name} is refused whole: nothing of it is shown, nothing loops`, async ({
      page,
      api,
    }) => {
      Object.assign(api.quoteSettings, settings);
      const logged: string[] = [];
      page.on('console', (m) => logged.push(m.text()));
      await amount(page).fill('0.05');
      await expect(cta(page)).toHaveText('Quote unavailable');
      await expect(receive(page)).toHaveText('0');
      await expect(main(page).getByText(/Best of|Expires in/)).toHaveCount(0);
      await expect(rateButton(page)).toHaveCount(0);
      // Nothing the answer carried is anywhere on the page.
      const text = await page.evaluate(() => document.body.innerText);
      for (const shown of ['124.75', '124.12', '0.0001 ETH']) expect(text).not.toContain(shown);
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      for (const secret of SECRETS) expect(html).not.toContain(secret);
      expect(logged.join('\n')).not.toMatch(/SIGNATURE|CALLDATA/);
      // No loop: it is not asked again by itself.
      await page.waitForTimeout(1_500);
      expect(quotes(api)).toHaveLength(1);
    });
  }

  test('an answer for the chain the API signed on, but whose chainId is a different number, is refused', async ({
    page,
    api,
  }) => {
    api.quoteSettings.echo = { chainId: 2 };
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
  });

  test('a wrap answered for another chain is refused too', async ({ page, api }) => {
    await pick(page, 'receive', 'WETH', 'Ethereum');
    api.quoteSettings.echo = { sellChain: 'evm:8453', buyChain: 'evm:8453', chainId: 8453 };
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
    await expect(receive(page)).toHaveText('0');
    await expect(main(page).getByText('Wrap, 1 to 1, no routing needed')).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(quotes(api)).toHaveLength(1);
  });

  test('a wrap with no chain echo is refused', async ({ page, api }) => {
    await pick(page, 'receive', 'WETH', 'Ethereum');
    api.quoteSettings.echo = { chainId: undefined };
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
  });

  test('a wrap that carries a lifetime is refused', async ({ page, api }) => {
    await pick(page, 'receive', 'WETH', 'Ethereum');
    api.quoteSettings.echo = { ttlSeconds: 60 };
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
  });

  test('the answer for the right chain is accepted, on every chain the app quotes', async ({
    page,
    api,
  }) => {
    await pick(page, 'pay', 'ETH', 'Base');
    await pick(page, 'receive', 'USDC', 'Base');
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Review swap');
    const body = quotes(api)[0]!.body as { sellToken: { chain: string } };
    expect(body.sellToken.chain).toBe('evm:8453');
  });
});

test.describe('the countdown and expiry', () => {
  test.beforeEach(async ({ page }) => openConnected(page));

  const secondsShown = async (page: Page) => {
    const text = await main(page)
      .getByText(/Expires in \d+s/)
      .textContent();
    return Number(/Expires in (\d+)s/.exec(text ?? '')![1]);
  };

  test('counts down from the answer, and an expired quote is replaced', async ({ page, api }) => {
    // The shortest lifetime the API allows (10 s). The countdown starts from what the quote has
    // left (at most 9 s: the server's whole-second clock may have lost one) and runs out.
    api.quoteSettings.ttlSec = 10;
    await ready(page);
    expect(await secondsShown(page)).toBeLessThanOrEqual(9);
    // Hold the replacement so the "expired" state can be seen.
    const next = deferred();
    api.override((r) => (r.path === '/v1/quotes' ? { gate: next.promise } : undefined));
    await expect(cta(page)).toHaveText('Quote expired', { timeout: 12_000 });
    await expect(note(page)).toHaveText('That quote expired. Getting a new one.');
    await expect(receive(page)).not.toHaveText('124.75');
    expect(quotes(api)).toHaveLength(2);
    api.quoteSettings.ttlSec = 60;
    next.release();
    await expect(cta(page)).toHaveText('Review swap');
    await expect(receive(page)).toHaveText('124.75');
  });

  test('a short lifetime counts down from the shorter value, not from the 60 s cap', async ({
    page,
    api,
  }) => {
    api.quoteSettings.ttlSec = 10;
    await ready(page);
    const first = await secondsShown(page);
    expect(first).toBeLessThanOrEqual(9);
    expect(first).toBeGreaterThanOrEqual(6);
    await expect
      .poll(() => secondsShown(page), { timeout: 6_000 })
      .toBeLessThanOrEqual(Math.max(first - 3, 0));
  });

  test('a long lifetime (600 s) is capped at 60 s, counted from the request', async ({
    page,
    api,
  }) => {
    api.quoteSettings.ttlSec = 600;
    await ready(page);
    expect(await secondsShown(page)).toBeLessThanOrEqual(60);
    expect(await secondsShown(page)).toBeGreaterThanOrEqual(55);
  });

  test('the default lifetime (60 s) shows at most 59 s: the server lost up to a second to rounding', async ({
    page,
  }) => {
    await ready(page);
    expect(await secondsShown(page)).toBeLessThanOrEqual(59);
  });

  test('a lifetime the API cannot configure (9 s) is refused, and nothing loops', async ({
    page,
    api,
  }) => {
    api.quoteSettings.ttlSec = 9;
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Quote unavailable');
    await expect(receive(page)).toHaveText('0');
    await page.waitForTimeout(1_500);
    expect(quotes(api)).toHaveLength(1);
  });

  test('a small difference between the device clock and the API clock changes nothing', async ({
    page,
    api,
  }) => {
    for (const ahead of [10, -10]) {
      api.quoteSettings.serverClockAheadSec = ahead;
      await amount(page).fill(ahead > 0 ? '0.05' : '0.06');
      await expect(cta(page)).toHaveText('Review swap');
      expect(await secondsShown(page)).toBeLessThanOrEqual(59);
      expect(await secondsShown(page)).toBeGreaterThanOrEqual(55);
    }
  });

  test("a device clock that runs behind the API's is reported, whatever the quote's deadline says", async ({
    page,
    api,
  }) => {
    api.quoteSettings.serverClockAheadSec = 3_600; // the deadline looks an hour further away
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Check your clock');
    await expect(note(page)).toContainText('Your device clock looks wrong');
    await expect(receive(page)).toHaveText('0');
    await expect(main(page).getByText(/Expires in|Best of/)).toHaveCount(0);
    await page.waitForTimeout(1_500);
    expect(quotes(api)).toHaveLength(1);
  });

  test('a device clock that runs ahead is reported, and nothing is asked in a loop', async ({
    page,
    api,
  }) => {
    api.quoteSettings.serverClockAheadSec = -3_600; // the deadline is already an hour past
    await amount(page).fill('0.05');
    await expect(cta(page)).toHaveText('Check your clock');
    await expect(note(page)).toContainText('Your device clock looks wrong');
    await expect(receive(page)).toHaveText('0');
    await page.waitForTimeout(1_500);
    expect(quotes(api)).toHaveLength(1);
  });

  test('the countdown text is not a live region and the status line says a quote is ready once', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const w = window as unknown as { __mutations: number };
      w.__mutations = 0;
      const region = document.querySelector('[role="status"][aria-label="Quote status"]')!;
      new MutationObserver(() => (w.__mutations += 1)).observe(region, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    await amount(page).pressSequentially('0.0123', { delay: 60 });
    await expect(cta(page)).toHaveText('Review swap');
    await expect(status(page)).toHaveText(
      /^Quote ready\. You receive 30\.\d\d USDC, at least 30\.\d\d USDC\.$/,
    );
    const settled = await page.evaluate(
      () => (window as unknown as { __mutations: number }).__mutations,
    );
    // Two seconds of countdown later the region has not been touched again.
    await page.waitForTimeout(2_200);
    expect(
      await page.evaluate(() => (window as unknown as { __mutations: number }).__mutations),
    ).toBe(settled);
    expect(settled).toBeLessThanOrEqual(3);
    // The countdown itself sits outside every live region.
    expect(
      await main(page)
        .getByText(/Expires in \d+s/)
        .evaluate((el) => !el.closest('[role="status"],[aria-live],output')),
    ).toBe(true);
  });
});

test.describe('conformance to the canvas (Web Swap, connected): computed values', () => {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`ready state at ${w}`, async ({ page }) => {
      await openConnected(page, w, h);
      await ready(page);
      const p = await box(panel(page));
      expect(p.width).toBe(w === 1440 ? 640 : 350);
      expect(p.x).toBe(w === 1440 ? 400 : 20);
      expect(
        await styles(panel(page), ['background-color', 'box-shadow', 'border-top-left-radius']),
      ).toEqual({
        'background-color': RGB.surface,
        'box-shadow': 'none',
        'border-top-left-radius': '0px',
      });

      // The button: 264 x 56, centred, 16 px under the panel, disabled (review does not exist yet).
      const c = await box(cta(page));
      expect([c.width, c.height]).toEqual([264, 56]);
      expect(c.x).toBe((w - 264) / 2);
      expect(c.y).toBe(p.y + p.height + 16);
      await expect(cta(page)).toBeDisabled();

      // The quoted amount is the amount style in ink; its token name stays sub (canvas).
      const out = await styles(receive(page), [
        'font-size',
        'font-weight',
        'color',
        'font-variant-numeric',
      ]);
      expect(out['font-size']).toBe('36px');
      expect(out['font-weight']).toBe('400');
      expect(out.color).toBe(RGB.ink);
      expect(out['font-variant-numeric']).toContain('tabular-nums');
      expect(
        (await styles(panel(page).getByRole('button', { name: /^Receive token:/ }), ['color']))
          .color,
      ).toBe(RGB.sub);

      // The USD value of the receive row: 15px sub, inside the panel's right padding.
      const usd = panel(page).getByText('$124.75');
      expect(await styles(usd, ['font-size', 'color'])).toEqual({
        'font-size': '15px',
        color: RGB.sub,
      });
      const u = await box(usd);
      expect(u.x + u.width).toBeCloseTo(p.x + p.width - 24, 0);

      // The route line: 13px sub with the 7px accent square; the rate pill: 36px, pill, 13px.
      const line = main(page)
        .getByText(/^Best of 3 routes/)
        .locator('..');
      expect(await styles(line, ['font-size', 'color', 'justify-content'])).toEqual({
        'font-size': '13px',
        color: RGB.sub,
        'justify-content': 'center',
      });
      const square = await box(line.locator('span').first());
      expect([square.width, square.height]).toEqual([7, 7]);
      const r = rateButton(page);
      const rb = await box(r);
      expect(rb.height).toBe(36);
      expect(rb.x + rb.width / 2).toBeCloseTo(w / 2, 0);
      expect(await styles(r, ['border-top-left-radius', 'font-size', 'color'])).toEqual({
        'border-top-left-radius': '999px',
        'font-size': '13px',
        color: RGB.ink,
      });

      // The details panel: 320 wide, square, a 1px line border and no shadow.
      await r.click();
      const d = main(page).getByRole('heading', { name: 'Rates and fees' }).locator('..');
      const db = await box(d);
      expect(db.width).toBe(320);
      expect(db.x + db.width / 2).toBeCloseTo(w / 2, 0);
      expect(
        await styles(d, [
          'background-color',
          'border-top-width',
          'border-top-color',
          'box-shadow',
          'border-top-left-radius',
        ]),
      ).toEqual({
        'background-color': RGB.surface,
        'border-top-width': '1px',
        'border-top-color': RGB.line,
        'box-shadow': 'none',
        'border-top-left-radius': '0px',
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
    });
  }

  test('at 390 a long receive amount and its USD value never overlap', async ({ page }) => {
    await openConnected(page, 390, 844);
    await amount(page).fill('1'); // 2,495.00 USDC next to $2,495.00
    await expect(receive(page)).toHaveText('2,495.00');
    const a = await box(receive(page));
    const token = await box(panel(page).getByRole('button', { name: /^Receive token:/ }));
    const usd = await box(panel(page).getByText('$2,495.00'));
    const right = (b: { x: number; width: number }) => b.x + b.width;
    // Either side by side with room, or the value on its own line below: never on top of the name.
    const sameLine = usd.y < token.y + token.height - 4;
    if (sameLine) expect(usd.x).toBeGreaterThanOrEqual(right(token) - 1);
    else expect(usd.y).toBeGreaterThanOrEqual(token.y + token.height - 1);
    expect(right(a)).toBeLessThanOrEqual(token.x + 1);
    expect(right(usd)).toBeLessThanOrEqual(390 - 20 - 24 + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  });

  test('a very long typed amount stays inside the panel', async ({ page }) => {
    await openConnected(page, 390, 844);
    await amount(page).fill('1'.repeat(70));
    await expect(cta(page)).toHaveText('Amount too large');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const p = await box(panel(page));
    const a = await box(amount(page));
    expect(a.x + a.width).toBeLessThanOrEqual(p.x + p.width);
  });
});

test.describe('accessibility', () => {
  async function scan(page: Page) {
    await page.waitForFunction(() => document.getAnimations().length === 0);
    return new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();
  }

  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`axe: no violations with a ready quote and its details at ${w}`, async ({ page }) => {
      await openConnected(page, w, h);
      await ready(page);
      await rateButton(page).click();
      expect((await scan(page)).violations).toEqual([]);
    });

    test(`axe: no violations while loading, on an error and when expired at ${w}`, async ({
      page,
      api,
    }) => {
      await openConnected(page, w, h);
      const gate = deferred();
      api.override((r) => (r.path === '/v1/quotes' ? { gate: gate.promise } : undefined));
      await amount(page).fill('0.05');
      await expect(cta(page)).toHaveText('Getting quote');
      expect((await scan(page)).violations).toEqual([]);
      gate.release();
      api.clearOverrides();
      api.override((r) =>
        r.path === '/v1/quotes'
          ? { status: 502, json: { error: 'no_route', failures: [] } }
          : undefined,
      );
      await amount(page).fill('0.06');
      await expect(cta(page)).toHaveText('No route found');
      expect((await scan(page)).violations).toEqual([]);
      await amount(page).fill('1');
      await expect(cta(page)).toHaveText('Insufficient balance');
      expect((await scan(page)).violations).toEqual([]);
    });

    test(`axe: no violations for an unsupported pair at ${w}`, async ({ page }) => {
      await openConnected(page, w, h);
      await pick(page, 'receive', 'USDC', 'Base');
      await expect(cta(page)).toHaveText('Pair not supported yet');
      expect((await scan(page)).violations).toEqual([]);
    });
  }

  test('the amount field is a labelled text field with a decimal keypad, not a number spinner', async ({
    page,
  }) => {
    await openConnected(page);
    const a = amount(page);
    await expect(a).toHaveAttribute('inputmode', 'decimal');
    await expect(a).not.toHaveAttribute('type', 'number');
    await expect(a).toHaveAccessibleName('Pay on Ethereum');
    await expect(a).toHaveAttribute('autocomplete', 'off');
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await expect(receive(page)).toHaveAttribute('aria-live', 'off');
  });

  test('keyboard only: amount, token, flip, rate and fees, and back', async ({ page }) => {
    await openConnected(page);
    await amount(page).focus();
    await page.keyboard.type('0.05');
    await expect(cta(page)).toHaveText('Review swap');
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      names.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '';
        }),
      );
    }
    // Pay token, flip, the receive chain and token; the disabled button is skipped; then the rate.
    expect(names.slice(0, 4)).toEqual([
      'Pay token: ETH, change',
      'Switch pay and receive',
      'Change chain, currently Ethereum',
      'Receive token: USDC, change',
    ]);
    expect(names[4]).toMatch(/^Rate and fees: 1 USDC equals 0\.0004008 ETH/);
    await page.keyboard.press('Enter');
    await expect(main(page).getByRole('heading', { name: 'Rates and fees' })).toBeVisible();
    await expect(rateButton(page)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(rateButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('the token button opens the picker, a pick closes it, and focus comes back', async ({
    page,
  }) => {
    await openConnected(page);
    const button = panel(page).getByRole('button', { name: 'Receive token: USDC, change' });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(pickerDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pickerDialog(page)).toBeHidden();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await pickerDialog(page).getByRole('combobox').fill('dai');
    await expect(pickerDialog(page).getByRole('option')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(pickerDialog(page)).toBeHidden();
    await expect(
      panel(page).getByRole('button', { name: 'Receive token: DAI, change' }),
    ).toBeFocused();
  });

  test('reduced motion: nothing animates or transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openConnected(page);
    await ready(page);
    await rateButton(page).click();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect((await styles(cta(page), ['transition-duration']))['transition-duration']).toBe('0s');
    expect((await styles(rateButton(page), ['transition-duration']))['transition-duration']).toBe(
      '0s',
    );
  });

  test('every control is 44px tall or has a 44px hit area', async ({ page }) => {
    await openConnected(page);
    await amount(page).fill('1');
    await expect(cta(page)).toHaveText('Insufficient balance');
    const small = await main(page)
      .locator('a:visible, button:visible')
      .evaluateAll((els) =>
        els
          .filter(
            (e) =>
              e.getBoundingClientRect().height < 44 &&
              !e.classList.contains('hit-area') &&
              getComputedStyle(e, '::after').content === 'none',
          )
          .map((e) => e.getAttribute('aria-label') ?? e.textContent),
      );
    expect(small).toEqual([]);
  });

  test('the visible focus ring is the canvas one on the token, flip and rate buttons', async ({
    page,
  }) => {
    await openConnected(page);
    await ready(page);
    for (const el of [
      panel(page).getByRole('button', { name: 'Pay token: ETH, change' }),
      panel(page).getByRole('button', { name: 'Switch pay and receive' }),
      rateButton(page),
    ]) {
      // Reached with the keyboard, so :focus-visible applies (a script's focus() after a click does not).
      await el.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(el).toBeFocused();
      const s = await styles(el, ['outline-style', 'outline-width', 'outline-offset']);
      expect(s).toEqual({
        'outline-style': 'solid',
        'outline-width': '2px',
        'outline-offset': '2px',
      });
    }
  });
});

/** Screenshots of the main states at the four widths (looked at by hand; no pixel baselines). */
test.describe('screenshots', () => {
  const states: [string, (page: Page, api: MockApi) => Promise<void>][] = [
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
            ? {
                status: 502,
                json: { error: 'no_route', failures: [{ provider: '0x', error: 'no_liquidity' }] },
              }
            : undefined,
        );
        await amount(page).fill('0.05');
        await expect(cta(page)).toHaveText('No route found');
      },
    ],
    [
      'expired',
      async (page, api) => {
        api.quoteSettings.ttlSec = 10; // the shortest the API allows
        // Every replacement is stopped too, so the screen settles on "expired".
        await ready(page);
        api.override((r) =>
          r.path === '/v1/quotes' ? { gate: new Promise(() => {}) } : undefined,
        );
        await expect(cta(page)).toHaveText('Quote expired', { timeout: 12_000 });
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

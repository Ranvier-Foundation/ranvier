import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { API_ORIGIN, installApi, type MockApi } from './api-mock';
import { ACCOUNT_A, ACCOUNT_B } from './wallet-fixture';
import { NOT_FOUND_ROUTE, UNBUILT_ROUTES } from './routes';

export { expect };

export interface CspViolation {
  directive: string;
  blocked: string;
  sample: string;
  disposition: string;
}

export interface CspRecord {
  /** Every `securitypolicyviolation` event on the page, across navigations and reloads. */
  violations: CspViolation[];
  /** Console messages about CSP (the browser logs every violation, enforced or report-only). */
  console: string[];
}

const CSP_CONSOLE = /Content[ -]Security[ -]Policy|Trusted Type/i;

/**
 * Starts recording CSP violations. Must run before the first navigation: the listener is added
 * when each document is created, before any of its scripts or styles are parsed.
 */
export async function recordCsp(page: Page): Promise<CspRecord> {
  const record: CspRecord = { violations: [], console: [] };
  await page.exposeFunction('__cspViolation', (v: CspViolation) => {
    record.violations.push(v);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const report = (window as unknown as { __cspViolation?: (v: unknown) => void })
        .__cspViolation;
      report?.({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        sample: e.sample,
        disposition: e.disposition,
      });
    });
  });
  page.on('console', (m) => {
    if (CSP_CONSOLE.test(m.text())) record.console.push(m.text());
  });
  return record;
}

/** Lets in-flight binding calls (violations, wallet calls) arrive before checking. */
export async function settle(page: Page): Promise<void> {
  try {
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  } catch {
    /* page already closed: use what was recorded */
  }
}

interface Fixtures {
  /**
   * On (default) for every test: fails the test on any CSP violation or CSP console message, any
   * request that leaves the origin, any console or page error, and any 4xx/5xx response (except
   * unbuilt nav routes, which Next prefetches, and the 404 test route). A retry never passes a test
   * whose earlier attempt saw a CSP violation. Only a test that provokes
   * these on purpose (the CSP negative test) turns it off with `test.use({ pageChecks: false })`.
   */
  pageChecks: boolean;
  /** The CSP recording for this test's page (always on). */
  csp: CspRecord;
  /**
   * The Ranvier API, answered by the test (api-mock.ts) on every page. It is the only origin besides
   * the app's own that a page may call; anything else (an RPC provider, say) fails the test.
   */
  api: MockApi;
  pageProblems: undefined;
}

export const test = base.extend<Fixtures>({
  pageChecks: [true, { option: true }],
  csp: async ({ page }, use) => {
    await use(await recordCsp(page));
  },
  api: async ({ page }, use) => {
    await use(await installApi(page));
  },
  pageProblems: [
    async ({ page, baseURL, pageChecks, csp, api }, use, testInfo) => {
      const list: string[] = [];
      // CI retries a failed test once. A CSP violation must not be rescued by that retry: the
      // first attempt leaves a marker (test-results is emptied at the start of every run) and
      // every later attempt of the same test fails with it.
      const marker = join(testInfo.project.outputDir, '.csp-violations', `${testInfo.testId}.txt`);
      if (pageChecks && testInfo.retry > 0 && existsSync(marker)) {
        list.push(`CSP violation on an earlier attempt: ${readFileSync(marker, 'utf8')}`);
      }
      const origin = new URL(baseURL ?? 'http://127.0.0.1:3100').origin;
      page.on('request', (r) => {
        const url = new URL(r.url());
        if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') {
          return;
        }
        if (url.origin !== origin && url.origin !== API_ORIGIN) {
          list.push(`third-party request: ${r.url()}`);
        }
      });
      // Every console message with its arguments read as data (an object logged with the address
      // in it shows as "JSHandle@object" in the text alone).
      const consoleLog: Promise<{ type: string; text: string }>[] = [];
      page.on('console', (m) => {
        const text = m.text();
        consoleLog.push(
          Promise.all(
            m.args().map((a) =>
              a
                .jsonValue()
                .then((v: unknown) => JSON.stringify(v) ?? '')
                .catch(() => ''),
            ),
          ).then((values) => ({ type: m.type(), text: `${text} ${values.join(' ')}` })),
        );
        // 404s are checked on the response below (unbuilt nav routes are prefetched).
        const failed = /Failed to load resource.*status of (\d{3})/.exec(text);
        let provoked = failed?.[1] !== undefined && api.provoked.has(Number(failed[1]));
        // A network failure is let through only when it is one the test caused, matched by URL and
        // count: any other failed request (an RPC call, another API path) still fails the test.
        if (/Failed to load resource: net::ERR_FAILED/.test(text)) {
          const url = m.location().url;
          const left = api.abortedUrls.get(url) ?? 0;
          if (left > 0) {
            api.abortedUrls.set(url, left - 1);
            provoked = true;
          }
        }
        if (m.type() === 'error' && !/Failed to load resource.*404/.test(text) && !provoked) {
          list.push(`console error: ${text}`);
        }
      });
      page.on('response', (r) => {
        const { pathname } = new URL(r.url());
        const expected404 =
          r.status() === 404 && (UNBUILT_ROUTES.has(pathname) || pathname === NOT_FOUND_ROUTE);
        const provoked = new URL(r.url()).origin === API_ORIGIN && api.provoked.has(r.status());
        if (r.status() >= 400 && !expected404 && !provoked) list.push(`${r.status()} ${r.url()}`);
      });
      page.on('pageerror', (e) => list.push(`page error: ${e.message}`));
      await use(undefined);
      if (!pageChecks) return;
      await settle(page);
      // The wallet address never goes to the console, at any level (log, info, warn, error,
      // debug), in either case, with or without 0x. The wallets are the fixture accounts and every
      // address the page sent to the API as a wallet.
      const wallets = new Set(
        [
          ACCOUNT_A,
          ACCOUNT_B,
          ...api.calls('balances').map((r) => (r.body as { address?: unknown } | null)?.address),
          ...api.calls('quotes').map((r) => (r.body as { taker?: unknown } | null)?.taker),
        ]
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.toLowerCase().replace(/^0x/, '')),
      );
      for (const { type, text } of await Promise.all(consoleLog)) {
        const lower = text.toLowerCase();
        if ([...wallets].some((hex) => hex !== '' && lower.includes(hex))) {
          list.push(`console ${type} contains a wallet address`);
        }
      }
      const cspProblems = [
        ...csp.violations.map(
          (v) => `CSP ${v.disposition} ${v.directive}: ${v.blocked} ${v.sample}`,
        ),
        ...csp.console.map((c) => `CSP console: ${c}`),
      ];
      if (cspProblems.length > 0) {
        mkdirSync(join(testInfo.project.outputDir, '.csp-violations'), { recursive: true });
        writeFileSync(marker, cspProblems.join('\n'));
      }
      list.push(...cspProblems);
      expect(list).toEqual([]);
    },
    { auto: true },
  ],
});

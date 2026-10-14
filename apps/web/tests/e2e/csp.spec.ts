import { request as httpRequest } from 'node:http';
import type { APIResponse, Page } from '@playwright/test';
import {
  apiOrigin,
  contentSecurityPolicy,
  staticSecurityHeaders,
} from '../../src/lib/security/csp';
import { hydrated } from './helpers';
import { expect, test, type CspViolation } from './fixtures';
import { NOT_FOUND_ROUTE, PROBE_PATHS, ROUTES, STATIC_MISS_PATHS } from './routes';
import { DEFAULT_WALLET, installWallets } from './wallet-fixture';

/**
 * The strict CSP (ADR 0008) against the production build: the header on every route, a fresh
 * nonce on every script, zero violations through the wallet flow and a client-side navigation,
 * and a negative test proving injected script and style are refused.
 */

const PAGES = [...ROUTES, NOT_FOUND_ROUTE];

// A CSP failure must never be rescued by a retry (CI retries other tests once): it is either a
// real hole or a real break. The shared fixture also fails any retry after a CSP violation.
test.describe.configure({ retries: 0 });

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One request with the path sent exactly as written (fetch would normalise `%2e%2e`). */
function raw(
  baseURL: string | undefined,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Raw> {
  const { hostname, port } = new URL(baseURL ?? 'http://127.0.0.1:3100');
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const header = (page: Page) => page.getByRole('banner');

function nonceOf(policy: string): string {
  const m = /script-src 'nonce-([A-Za-z0-9+/]{22}==)' /.exec(policy);
  if (!m?.[1]) throw new Error(`no nonce in ${policy}`);
  return m[1];
}

async function policyOf(res: APIResponse): Promise<string> {
  const policy = res.headers()['content-security-policy'];
  if (!policy) throw new Error(`no CSP on ${res.url()}`);
  return policy;
}

test.describe('header', () => {
  for (const route of PAGES) {
    test(`${route}: strict policy, fresh nonce, every script carries it`, async ({ request }) => {
      const first = await request.get(route);
      const second = await request.get(route);
      expect(first.status()).toBe(route === NOT_FOUND_ROUTE ? 404 : 200);

      const policy = await policyOf(first);
      const nonce = nonceOf(policy);
      // Exactly the production policy: no 'unsafe-eval' (dev only), no report-only copy.
      expect(policy).toBe(
        contentSecurityPolicy({
          nonce,
          api: apiOrigin(process.env.NEXT_PUBLIC_API_URL, 'production'),
          dev: false,
        }),
      );
      expect(policy).not.toMatch(/unsafe-|'self'[^;]*'strict-dynamic'|script-src[^;]*'self'/);
      expect(first.headers()['content-security-policy-report-only']).toBeUndefined();
      expect(nonceOf(await policyOf(second))).not.toBe(nonce);

      const html = await first.text();
      const scripts = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag).toContain(` nonce="${nonce}"`);
      // The only other nonced tags are Next's stylesheet and preload links; no inline <style>.
      expect(html).not.toMatch(/<style\b/);
      expect(html).not.toContain(nonceOf(await policyOf(second)));

      // The per-request page must never be cached by a proxy or CDN (nonce reuse).
      const cache = first.headers()['cache-control'] ?? '';
      expect(cache).toContain('private');
      expect(cache).toContain('no-store');
      for (const { key, value } of staticSecurityHeaders()) {
        expect(first.headers()[key.toLowerCase()]).toBe(value);
      }
    });
  }

  test('static assets are immutable and carry no per-request policy', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const chunk = /src="(\/_next\/static\/chunks\/[^"]+\.js)"/.exec(html)?.[1];
    expect(chunk).toBeDefined();
    const res = await request.get(chunk ?? '');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('immutable');
    expect(res.headers()['content-security-policy']).toBeUndefined();
    expect(res.headers()['cross-origin-resource-policy']).toBe('same-origin');
  });
});

test.describe('matcher coverage', () => {
  for (const path of PROBE_PATHS) {
    test(`${path}: answered by the app under the policy`, async ({ baseURL }) => {
      const res = await raw(baseURL, 'GET', path);
      expect([200, 404]).toContain(res.status);
      expect(String(res.headers['content-type'])).toContain('text/html');
      const policy = String(res.headers['content-security-policy'] ?? '');
      const nonce = nonceOf(policy);
      expect(res.headers['content-security-policy-report-only']).toBeUndefined();
      expect(String(res.headers['cache-control'])).toMatch(/private.*no-store|no-store.*private/);
      const scripts = res.body.match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag).toContain(` nonce="${nonce}"`);
      expect(res.body).not.toMatch(/<style\b/);
    });
  }

  /** As Caddy or Cloudflare forward a request: TLS ends in front, plain HTTP to the app. */
  const FORWARDED = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example.com' };
  for (const path of ['/_global-error', '/_global-error.html', '/_global-error.rsc']) {
    for (const [label, headers] of [
      ['direct', {}],
      ['behind a TLS proxy', FORWARDED],
      ['behind a TLS proxy, RSC', { ...FORWARDED, rsc: '1' }],
    ] as const) {
      test(`${path} (${label}): plain 404 from the proxy, never the cacheable error page`, async ({
        baseURL,
      }) => {
        const res = await raw(baseURL, 'GET', path, headers);
        expect(res.status).toBe(404);
        expect(res.body).toBe('Not Found');
        expect(String(res.headers['content-type'])).toContain('text/plain');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-middleware-rewrite']).toBeUndefined();
        nonceOf(String(res.headers['content-security-policy'] ?? ''));
      });
    }
  }

  test('/x.rsc behind a TLS proxy is an ordinary 404 under the policy', async ({ baseURL }) => {
    const res = await raw(baseURL, 'GET', '/x.rsc', FORWARDED);
    expect(res.status).toBe(404);
    expect(res.headers['x-middleware-rewrite']).toBeUndefined();
    expect(String(res.headers['cache-control'])).toContain('no-store');
    nonceOf(String(res.headers['content-security-policy'] ?? ''));
  });

  for (const method of ['HEAD', 'POST']) {
    test(`${method} /: policy and no-store`, async ({ baseURL }) => {
      const res = await raw(baseURL, method, '/');
      expect(res.status).toBe(200);
      nonceOf(String(res.headers['content-security-policy'] ?? ''));
      expect(String(res.headers['cache-control'])).toContain('no-store');
    });
  }

  for (const path of STATIC_MISS_PATHS) {
    test(`${path}: build-asset miss is a plain-text 404 (no HTML, so no policy needed)`, async ({
      baseURL,
    }) => {
      const res = await raw(baseURL, 'GET', path);
      expect(res.status).toBe(404);
      expect(String(res.headers['content-type'])).toContain('text/plain');
      expect(res.body).not.toMatch(/<html|<script/i);
      expect(res.headers['content-security-policy']).toBeUndefined();
    });
  }
});

test.describe('no violations', () => {
  for (const route of PAGES) {
    for (const width of [1440, 390]) {
      test(`${route} at ${width}`, async ({ page, csp }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route);
        await hydrated(page);
        await page.evaluate(() => document.fonts.ready);
        const modal = page.getByRole('dialog');
        if (await modal.isVisible()) {
          // A route that opens a modal (Select token): the page behind it is inert, so check the
          // modal itself, with its data loaded from the API origin the policy allows.
          await expect(modal.getByRole('option').first()).toBeVisible();
        } else {
          // Hydrated: the header's client components respond.
          const more = header(page).getByRole('button', { name: 'More' });
          await more.click();
          await expect(more).toHaveAttribute('aria-expanded', 'true');
        }
        expect(csp.violations).toEqual([]);
        expect(csp.console).toEqual([]);
      });
    }
  }

  test('connect dialog, connected wallet, wallet and network menus', async ({ page, csp }) => {
    await installWallets(page);
    await page.goto('/');
    await hydrated(page);
    await header(page).getByRole('button', { name: 'Connect wallet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect wallet' });
    await expect(dialog).toBeVisible();
    // The wallet icon (a data: URI) loaded under img-src.
    const icon = dialog.locator('img').first();
    await expect
      .poll(() => icon.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0))
      .toBe(true);
    await dialog.getByRole('button', { name: new RegExp(DEFAULT_WALLET.name) }).click();
    const pill = header(page).getByRole('button', { name: /^Wallet 0x/ });
    await expect(pill).toBeVisible();
    await pill.click();
    await page.keyboard.press('Escape');
    const network = header(page).getByRole('button', { name: /^Network:/ });
    await network.click();
    await expect(network).toHaveAttribute('aria-expanded', 'true');
    // Reload: the persisted connection comes back under the same policy.
    await page.reload();
    await hydrated(page);
    await expect(pill).toBeVisible();
    expect(csp.violations).toEqual([]);
    expect(csp.console).toEqual([]);
  });

  test('client-side navigation loads a new chunk under strict-dynamic', async ({ page, csp }) => {
    await page.goto(NOT_FOUND_ROUTE);
    await hydrated(page);
    await page.evaluate(() => {
      (window as unknown as { __sameDocument?: boolean }).__sameDocument = true;
    });
    const loaded: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'script') loaded.push(r.url());
    });
    await page.getByRole('link', { name: 'Back to Swap' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('region', { name: 'Swap' })).toBeVisible();
    // Same document (no full reload), and the page's chunk was fetched by Next's loader.
    expect(
      await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument),
    ).toBe(true);
    expect(loaded.length).toBeGreaterThan(0);
    expect(csp.violations).toEqual([]);
    expect(csp.console).toEqual([]);
  });
});

test.describe('injected markup is refused', () => {
  // This test provokes violations on purpose; it checks them itself.
  test.use({ pageChecks: false });

  test('inline script, handler, javascript: URL, foreign and same-origin script, styles', async ({
    page,
    csp,
  }) => {
    let gadget = '';
    // Chromium announces a request even when CSP refuses it; it must fail, never get a response.
    const foreign: string[] = [];
    page.on('response', (r) => {
      if (r.url().includes('evil.example')) foreign.push(`response ${r.url()}`);
    });
    page.on('requestfailed', (r) => {
      if (r.url().includes('evil.example')) foreign.push(`failed ${r.failure()?.errorText ?? ''}`);
    });
    // Simulates a server-side HTML injection: the payload arrives inside our own document.
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const res = await route.fetch();
      let body = await res.text();
      gadget = /src="(\/_next\/static\/chunks\/[^"]+\.js)"/.exec(body)?.[1] ?? '';
      const payload = [
        '<script>window.__pInline=1</script>',
        '<img src="data:," alt="" onerror="window.__pHandler=1">',
        '<a id="p-js" href="javascript:window.__pUrl=1">x</a>',
        '<script src="https://evil.example/x.js"></script>',
        `<script src="${gadget}?gadget"></script>`,
        '<p id="p-attr" style="color: rgb(1, 2, 3)">x</p>',
        '<style>#p-el { color: rgb(4, 5, 6) }</style><p id="p-el">x</p>',
      ].join('');
      body = body.replace('</body>', `${payload}</body>`);
      await route.fulfill({ response: res, body });
    });

    await page.goto('/');
    await hydrated(page);
    expect(gadget).not.toBe('');
    await page.locator('#p-js').click();
    // The app itself still runs under the policy.
    await header(page).getByRole('button', { name: 'More' }).click();
    await expect(header(page).getByRole('button', { name: 'More' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    const ran = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { inline: w.__pInline, handler: w.__pHandler, url: w.__pUrl };
    });
    expect(ran).toEqual({ inline: undefined, handler: undefined, url: undefined });
    await expect(page.locator('#p-attr')).not.toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(page.locator('#p-el')).not.toHaveCSS('color', 'rgb(4, 5, 6)');
    expect(foreign).toEqual(['failed csp']);

    const seen = (want: Partial<CspViolation>, sampleHas?: string) =>
      csp.violations.some(
        (v) =>
          v.disposition === 'enforce' &&
          Object.entries(want).every(([k, val]) => v[k as keyof CspViolation] === val) &&
          (sampleHas === undefined || v.sample.includes(sampleHas)),
      );
    await expect.poll(() => csp.violations.length).toBeGreaterThanOrEqual(7);
    const base = new URL(page.url()).origin;
    expect({
      inlineScript: seen({ directive: 'script-src-elem', blocked: 'inline' }, '__pInline'),
      handler: seen({ directive: 'script-src-attr', blocked: 'inline' }, '__pHandler'),
      javascriptUrl: seen({ directive: 'script-src-elem', blocked: 'inline' }, 'javascript:'),
      foreignScript: seen({ directive: 'script-src-elem', blocked: 'https://evil.example/x.js' }),
      sameOriginGadget: seen({
        directive: 'script-src-elem',
        blocked: `${base}${gadget}?gadget`,
      }),
      styleAttribute: seen({ directive: 'style-src-attr', blocked: 'inline' }),
      styleElement: seen({ directive: 'style-src-elem', blocked: 'inline' }),
    }).toEqual({
      inlineScript: true,
      handler: true,
      javascriptUrl: true,
      foreignScript: true,
      sameOriginGadget: true,
      styleAttribute: true,
      styleElement: true,
    });
    // Nothing else was refused: the app's own scripts and styles all passed.
    expect(csp.violations).toHaveLength(7);
  });
});

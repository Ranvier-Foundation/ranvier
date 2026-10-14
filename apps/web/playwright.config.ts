import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

/**
 * The API origin the web build was made with (NEXT_PUBLIC_API_URL is baked in at build time and
 * allowed by the CSP). Tests answer it themselves (tests/e2e/api-mock.ts), so it only has to
 * match the build: `pnpm e2e` and CI build with this same default.
 */
process.env['NEXT_PUBLIC_API_URL'] ??= 'http://127.0.0.1:3199';

/**
 * Local runs may use a system Chromium (see docs/ui-guidelines.md, "Looking at the page locally").
 * Unset, Playwright uses its own downloaded browser exactly as before.
 */
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const launchOptions = chromiumPath
  ? {
      executablePath: chromiumPath,
      ...(process.env.CI ? {} : { args: ['--no-sandbox'] }),
    }
  : {};

/**
 * Runs against the production build: `pnpm build` first, then this starts `next start`.
 * No pixel baselines (fonts differ between machines); tests assert computed values instead.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', launchOptions } }],
  webServer: {
    command: `pnpm exec next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

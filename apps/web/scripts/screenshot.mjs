/**
 * Screenshots of the production build at the four artboard widths, for looking at the page.
 * Usage: PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium pnpm --filter @ranvier/web screenshot [routes...] [--out dir]
 * Needs `pnpm --filter @ranvier/web build` first. See docs/ui-guidelines.md, "Looking at the page locally".
 */
/* global process, console, fetch, setTimeout, document */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { fileName, parseArgs, VIEWPORTS } from './screenshot-args.ts';

function freePort() {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => done(port));
    });
  });
}

async function waitFor(url, server, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (server.exitCode !== null) throw new Error(`next start exited with ${server.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not answer at ${url}`);
}

async function main() {
  const { routes, out } = parseArgs(process.argv.slice(2));
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });

  const port = await freePort();
  const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
  const server = spawn(
    process.execPath,
    [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const stop = () => {
    if (server.exitCode === null) server.kill('SIGKILL');
  };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

  const files = [];
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(base, server);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      ...(executablePath && !process.env.CI ? { args: ['--no-sandbox'] } : {}),
    });
    for (const route of routes) {
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({ viewport });
        // `load` plus fonts; `networkidle` never settles on this app.
        await page.goto(base + route, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const file = resolve(outDir, fileName(route, viewport));
        await page.screenshot({ path: file });
        await page.close();
        files.push(file);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    stop();
  }
  console.log(files.join('\n'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

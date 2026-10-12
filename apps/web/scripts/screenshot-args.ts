/** Argument parsing for scripts/screenshot.mjs (kept separate so it can be unit tested). */

export interface Viewport {
  width: number;
  height: number;
}

/** The four artboard widths, with the heights used for review. */
export const VIEWPORTS: readonly Viewport[] = [
  { width: 1440, height: 900 },
  { width: 1200, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

export interface ScreenshotArgs {
  routes: string[];
  out: string;
}

export const DEFAULT_OUT = './.screenshots';

/** `--out <dir>` or `--out=<dir>`; every other argument is a route (must start with `/`). */
export function parseArgs(argv: readonly string[]): ScreenshotArgs {
  const routes: string[] = [];
  let out = DEFAULT_OUT;
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === '--out') {
      const value = rest.shift();
      if (!value) throw new Error('--out needs a directory');
      out = value;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
      if (!out) throw new Error('--out needs a directory');
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else if (arg.startsWith('/')) {
      routes.push(arg);
    } else {
      throw new Error(`route must start with "/": ${arg}`);
    }
  }
  return { routes: routes.length > 0 ? routes : ['/'], out };
}

/** `/` becomes `home`, `/trade/eth` becomes `trade-eth`. */
export function routeSlug(route: string): string {
  const slug = route
    .replace(/[?#].*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'home';
}

export function fileName(route: string, viewport: Viewport): string {
  return `${routeSlug(route)}-${viewport.width}x${viewport.height}.png`;
}

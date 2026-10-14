/** Every built screen. The axe scan and the CSP spec both walk this list: add new screens here. */
export const ROUTES: readonly string[] = ['/'];

/** A route that does not exist: the app's own 404 page. */
export const NOT_FOUND_ROUTE = '/this-page-does-not-exist';

/** Nav targets whose screens do not exist yet; Next prefetches them and gets a 404. */
export const UNBUILT_ROUTES: ReadonlySet<string> = new Set([
  '/trade',
  '/buy',
  '/activity',
  '/portfolio',
  '/account',
  '/notifications',
  '/select-token',
  '/settings',
]);

/**
 * Outbound HTTP never follows redirects (ADR 0009). Node's fetch follows them by default: a 307
 * re-sends the request body to the new host, and across origins only `Authorization` is
 * stripped, so a custom key header (`0x-api-key`) would be forwarded. Every outbound fetch in the
 * API sends `redirect: 'error'` and treats a redirect as an upstream failure with a fixed reason.
 */

/** `fetch` with `redirect: 'error'` fails a 3xx with a TypeError whose cause names it. */
export function isRedirectError(err: unknown): boolean {
  const cause = (err as { cause?: { message?: unknown } } | null)?.cause;
  return err instanceof TypeError && /redirect/i.test(String(cause?.message));
}

/** A 3xx that reached the caller anyway (a fetch that ignored `redirect: 'error'`). */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

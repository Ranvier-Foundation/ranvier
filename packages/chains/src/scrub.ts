/**
 * Removing RPC URLs from text that may be printed or logged. RPC URLs often carry an API key in
 * the path, query or user info, and runtime errors (e.g. `Failed to parse URL from <url>`, or a
 * client library quoting the URL it called) can repeat them. Shared by `verify:tokens` and the
 * API's chain reader.
 */

/** `scheme://...`, or a bare `host.tld/...` with a path. */
const URL_LIKE = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]*/gi,
  /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s"'<>()]*/gi,
];

/** Replaces every URL-looking substring with `<rpc-url>`. Over-scrubbing is safe. */
export function scrubUrls(text: string): string {
  return URL_LIKE.reduce((t, re) => t.replace(re, '<rpc-url>'), text);
}

/** An error as one short line with any URL removed. */
export const errText = (err: unknown): string =>
  scrubUrls(err instanceof Error ? err.message : String(err)).slice(0, 200);

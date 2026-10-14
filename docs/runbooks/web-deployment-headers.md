# Runbook: web security headers in deployment

The web app's security headers come from the app itself (ADR 0008):

- **The Content-Security-Policy** comes from `apps/web/src/proxy.ts`, with a new nonce on every request.
- **All other headers** (HSTS, nosniff, frame, referrer, permissions, COOP, CORP) come from `apps/web/next.config.ts`.

Everything in front of the app (Caddy or Nginx, then Cloudflare) must pass them through untouched. Anything that caches HTML or injects scripts into it breaks the policy, or weakens it silently.

## Never

- **Never cache HTML.** Next sends `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` on every page. Keep it.
  - Caddy: no `cache` handler on page routes.
  - Cloudflare: no "Cache Everything" rule, no edge-cache TTL override, no APO.
  - A cached page reuses one nonce for everyone, which defeats the policy.
- **Never set, change or remove `Content-Security-Policy` or `Content-Security-Policy-Report-Only`** at the proxy or CDN. No `header` directive in Caddy, no Transform Rule in Cloudflare.
- **Never forward a client's own CSP request header.** The app drops it, but do not rely on that alone.
- **Never let the CDN inject or rewrite HTML or JS.** In Cloudflare, turn off:
  - Rocket Loader
  - Zaraz
  - Email Address Obfuscation
  - Auto Minify (HTML, JS, CSS) where the plan still offers it
  - Web Analytics automatic beacon injection
  - Mirage and Polish on HTML
  - Server-side Excludes
  - Automatic HTTPS Rewrites (HSTS already covers this)

  Each of these inserts or rewrites scripts, which the strict policy refuses.

## Allowed

- Cache `/_next/static/*` at the edge for as long as you like. These files are immutable (`Cache-Control: public, max-age=31536000, immutable`), and Next sends no CSP on them.
- Compression (gzip or brotli) of responses.
- A Cloudflare challenge page (bot or DDoS) is a separate response from Cloudflare, so it does not need our policy.

## Verify after every deploy

```sh
# Policy present, enforced, nonce changes per request, page not cacheable.
for i in 1 2; do curl -sI https://<web-host>/ | grep -iE '^(content-security-policy|cache-control|strict-transport-security|cross-origin)'; done
# A static asset: immutable, no CSP.
curl -sI "https://<web-host>$(curl -s https://<web-host>/ | grep -o '/_next/static/chunks/[^"]*\.js' | head -1)" | grep -iE '^(cache-control|content-security-policy|cf-cache-status)'
```

Expected:

- Two different `'nonce-…'` values.
- `script-src 'nonce-…' 'strict-dynamic' 'report-sample'`, with no `unsafe-` anywhere.
- No `cf-cache-status: HIT` on the page.
- `Cache-Control` containing `private` and `no-store`.

Then open the site in a browser with DevTools, connect a wallet, and check the console shows no "Content Security Policy" messages. In CI, `pnpm --filter @ranvier/web check:headers` runs the same checks against the standalone server.

## First rollout: Report-Only

1. Deploy to staging with `CSP_REPORT_ONLY=1`. The same policy is sent as `Content-Security-Policy-Report-Only`, so violations are logged in the browser console without blocking anything.
2. Use the site through the proxy and CDN: every screen, connect a wallet, switch networks, reload. Check the console for `[Report Only]` CSP messages; there must be none. (A report endpoint is a later change. Until then, the console is the only report.)
3. Remove `CSP_REPORT_ONLY` (or set it to anything but `1`), redeploy and verify as above. Production always enforces.

## DNS and HSTS

- **DNSSEC:** enable it in Cloudflare and publish the DS record at the registrar. Check with `dig +dnssec <domain>` (look for `ad` and RRSIG records).
- **HSTS preload:** the header already carries `preload`. Submit the domain at hstspreload.org only once the production domain exists and every subdomain serves HTTPS. Leaving the list later takes months.
- Keep `max-age=63072000; includeSubDomains`. Never lower it once deployed.

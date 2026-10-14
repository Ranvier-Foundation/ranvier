# ADR 0008: Strict Content Security Policy (web)

- Status: accepted
- Date: 2026-10-13

## Context

Until now, `apps/web` sent `script-src 'self' 'unsafe-inline'` and `style-src 'self' 'unsafe-inline'`. The app now contains wallet code (ADR 0007), and signing comes next. With `'unsafe-inline'`, any HTML-injection bug becomes script execution on a trusted origin that holds a connected wallet. That script can ask the wallet to send a transaction. The spec (section 9, frontend hijack protection) requires a strict CSP, Subresource Integrity, HSTS, DNSSEC and monitored deployment changes. ADR 0007 made a strict CSP a precondition of any signing or transaction flow.

The app runs on Next.js 16.4 (App Router, Turbopack, `output: 'standalone'`), self-hosted behind Caddy or Nginx. Cloudflare provides DNS, CDN and DDoS protection only.

Measured before deciding, on a production build in Chromium:

- **Today's policy does not stop injection.** An inline `<script>`, an `<img onerror>` handler and a `javascript:` link injected into our HTML all executed. Only a foreign-origin script was refused.
- **Next inlines 11 bootstrap and RSC-payload scripts.** With `script-src 'self'` and no inline allowance, all 11 are refused and the app does not hydrate.
- **Option A: per-request nonces.** A proxy (`src/proxy.ts`) generates a nonce and sends it in the request's CSP header; Next 16.4 then puts it on every `<script>` (22 of 22 on `/`) and on its stylesheet and preload links. This only works when the page is rendered per request. On prerendered pages none of the scripts carry the nonce, and the browser reported 25 violations.
- **Option B: hashes with `experimental.sri`.** Pages stay static. The policy is `script-src 'self'` plus the hashes of the inline scripts. It works, but:
  - the hashes change on every build (the build ID is embedded), so they must be computed after the build;
  - `'self'` stays, so an injected same-origin chunk (a "script gadget") still runs (proven);
  - any route rendered per request would need nonces anyway.
- **Option B with `'strict-dynamic'`.** Broken in 16.4: Turbopack adds `integrity` to only 7 of 11 initial scripts and never to chunks loaded at runtime.
- **Trusted Types.** `require-trusted-types-for 'script'` would break Turbopack's chunk loader, which does `script.src = "<string>"` (proven: "requires 'TrustedScriptURL' assignment").

## Decision

### Nonces with `'strict-dynamic'`, and every route rendered per request

- `src/proxy.ts` runs on every request except `/_next/static/*`, including prefetch and RSC requests, so no page render skips the policy. For each request it:
  - creates a 128-bit nonce from Web Crypto;
  - builds the policy with `src/lib/security/csp.ts` (pure and unit tested);
  - drops any CSP header the client sent;
  - forwards the policy on the request, where Next reads the nonce, and sends the same policy on the response.
- The root layout calls `await connection()`, so every route renders per request and receives the nonce. Static prerendering, ISR and Partial Prerendering are given up for HTML. Static assets are unchanged (`/_next/static/*`, `immutable`).
- Measured cost on loopback for `/`:

  | Build               | p50, sequential | Throughput at 20 concurrent       |
  | ------------------- | --------------- | --------------------------------- |
  | Before (static)     | 4.7 to 5.3 ms   | about 865 req/s (p50 20 to 22 ms) |
  | After (per request) | 7.2 to 9.7 ms   | about 230 req/s (p50 85 to 87 ms) |

  This is acceptable for this app. HTML for a wallet app should not be cached at the edge anyway: a cached page would reuse a nonce.

- Next marks these pages `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`. Caddy and Cloudflare must never cache HTML or change that header (runbook below).

### The policy

```
default-src 'none'; script-src 'nonce-{N}' 'strict-dynamic' 'report-sample'; style-src 'self' 'nonce-{N}'; img-src 'self' data:; font-src 'self'; connect-src 'self' {API_ORIGIN}; manifest-src 'self'; worker-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
```

- **No `'unsafe-inline'`, no `'self'` and no host in `script-src`.** Only nonced scripts, and what they load, run. `'report-sample'` adds the first characters of a blocked script to the violation.
- **`style-src` has no `'unsafe-inline'`.** The app emits no inline style (PR #22: ESLint forbids the `style` prop, `<style>` and `dangerouslySetInnerHTML`; the app has its own 404 and global-error pages).
- **`next dev` only:** `'unsafe-eval'` for scripts (React rebuilds server error stacks with `eval`) and `style-src 'self' 'unsafe-inline'`, because Turbopack's dev CSS loader injects un-nonced `<style>` elements (33 violations measured without it). A production build never contains `unsafe-*`; unit tests, e2e tests and the CI header check all assert this.
- **`{API_ORIGIN}`** is decided at build time only. next.config.ts validates `NEXT_PUBLIC_API_URL` with `apiOrigin()` (an http(s) origin only, https in production except loopback), so a bad value fails the build. It then bakes the origin into the build as `RANVIER_BUILD_API_ORIGIN` through Next's `env` option, which replaces it with a literal (empty when unset). The proxy reads only that literal. Before this, an unset build value left `process.env.NEXT_PUBLIC_API_URL` to be read at runtime: a server variable could change `connect-src`, and an invalid one answered every request with a 500. Runtime is the wrong place for this anyway: the client bundle bakes `NEXT_PUBLIC_API_URL` at build, so a runtime-only value could never be used by the page. Changing the API origin means rebuilding, as it already did for the client.
- **Report-Only only on staging.** `CSP_REPORT_ONLY=1` together with `RANVIER_ENV=staging` (exact values, read once at server start) sends the same policy as `Content-Security-Policy-Report-Only`, for a first run behind the real proxy and CDN. `CSP_REPORT_ONLY=1` without `RANVIER_ENV=staging` is **ignored**: the policy stays enforced, so a flag left over from staging cannot turn production into report-only. Both cases log one `[security]` warning at server start (`src/instrumentation.ts`).
- **`/_global-error`.** Next's built-in error route answers its own URL with a prerendered page that is cacheable (`s-maxage=31536000`), carries inline styles and has no nonces. The proxy rewrites any direct request for it to the app's 404, under the policy. Real errors still render the error page inside the failing request, which never passes through that URL.

### Other headers (next.config.ts, every response)

| Header                         | Value                                                                            | Change                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Strict-Transport-Security`    | `max-age=63072000; includeSubDomains; preload`                                   | unchanged                                                                                                                                                                                 |
| `X-Content-Type-Options`       | `nosniff`                                                                        | unchanged                                                                                                                                                                                 |
| `X-Frame-Options`              | `DENY`                                                                           | unchanged (browsers without `frame-ancestors`)                                                                                                                                            |
| `Referrer-Policy`              | `no-referrer`                                                                    | was `strict-origin-when-cross-origin`; no flow needs a Referer, the API checks `Origin`, and future URLs may carry addresses or amounts                                                   |
| `Permissions-Policy`           | adds `payment`, `usb`, `serial`, `hid`, `bluetooth`, `browsing-topics` (all off) | was camera, microphone and geolocation only; hardware wallets over WebHID will need `hid=(self)` as a deliberate change                                                                   |
| `Cross-Origin-Opener-Policy`   | `same-origin`                                                                    | new: no other window keeps a handle on ours (tab-nabbing, cross-window leaks); a popup wallet SDK would need `same-origin-allow-popups`, which ADR 0007 already makes a deliberate change |
| `Cross-Origin-Resource-Policy` | `same-origin`                                                                    | new: other sites cannot embed our responses                                                                                                                                               |

`Cross-Origin-Embedder-Policy` is not set. Nothing needs cross-origin isolation, and `require-corp` would get in the way of future images.

### Chain reads go through our API

Balances and other RPC reads will be fetched through `apps/api`, never from RPC endpoints in the browser. `connect-src` therefore stays `'self'` plus the API origin. RPC keys stay on the server, and the API can rate-limit and cache. The cost is load and latency on our API. Balances are display data; the wallet still shows and signs the real transaction.

### Subresource Integrity: deliberate deviation from the spec

The spec asks for SRI. `experimental.sri` is not enabled:

- **It is incomplete in 16.4 with Turbopack:** 7 of 11 initial scripts, no runtime chunks, no CSS.
- **It is experimental.**
- **It adds little for same-origin files.** Someone who can tamper with our static files at the CDN or a cache can usually also change the HTML, which is where the hashes live.

The spec's intent (detect a modified frontend) will be met by release-manifest monitoring instead, in a later change:

- `generateBuildId` pinned to the git SHA;
- CI publishes a signed manifest (sha256 of every file in `.next/static`, plus the build ID and git SHA);
- a worker on another host fetches the live HTML, the scripts and stylesheets it references and its headers, compares them with the manifest and alerts on any difference.

Revisit SRI when Next supports it fully for Turbopack.

### Not done here

- **Reporting.** No `report-uri`, `report-to` or `Reporting-Endpoints` until the report endpoint exists. They would point at nothing. Planned endpoint: `POST /v1/csp-report` on the API, which:
  - accepts `application/csp-report` and `application/reports+json` bodies of at most 8 KB;
  - rate-limits per IP and globally, and keeps the IP only for rate limiting;
  - strips query and fragment from URLs (they may hold addresses) and truncates samples;
  - stores counts by directive, blocked origin and release for 30 days, with alerts on new combinations.
- **Trusted Types.** Not sent, not even Report-Only. With no report target it would only print console warnings when Next's loader fetches a chunk. Those warnings are noise, and the e2e suite fails on any CSP console message. Enforcement first needs a `default` Trusted Types policy that passes only `/_next/static/` script URLs. Revisit together with the report endpoint.
- **HSTS preload submission.** Deferred until the production domain exists. Every subdomain must serve HTTPS before submitting, and leaving the preload list later takes months.
- **DNSSEC.** A deployment task (runbook below).

## Testing

- **Unit (`tests/unit/security-headers.test.ts`):**
  - the exact policy for a fixed nonce;
  - production has no `unsafe-*` and no `'self'` or host in `script-src`;
  - dev differs only in its two documented sources;
  - nonces are 16 bytes of base64 and unique over 10,000 calls;
  - a malformed nonce throws;
  - the proxy drops client-sent CSP headers and uses a new nonce per request;
  - Report-Only needs both flags; a stray `CSP_REPORT_ONLY=1` is ignored; each case warns exactly once;
  - `connect-src` comes only from the baked origin, and next.config.ts bakes it;
  - `/_global-error` is rewritten to the 404;
  - the proxy `matcher`, compiled and matched by Next's own functions, skips `/_next/static/*` and nothing else (dotted paths, `/_next/…`, encoded paths and data routes are all covered);
  - the static headers, and every `apiOrigin()` case, including a bad value failing next.config.ts.
- **e2e (`tests/e2e/csp.spec.ts`, production build), on every route in `tests/e2e/routes.ts` and on the 404:**
  - the exact header, a different nonce on a second request, the nonce on every `<script>`, `private, no-store`;
  - zero violations and zero CSP console messages at 1440 and 390 px; through the connect dialog, a connected wallet, the wallet and network menus and a reload; and through a client-side navigation that loads a new chunk with Next's loader (404 to "Back to Swap");
  - matcher coverage: every path in `PROBE_PATHS` (`/robots.txt`, `/favicon.ico`, `/nope.`, `/_next/foo`, `/%2e%2e/`, `/a%2fb`, `/_next/data/x/y.json`, `/api/x`, `/_global-error`, `/_not-found`), sent byte for byte, is app HTML under the policy, with the nonce on every script and `no-store`;
  - `HEAD /` and `POST /` carry the policy;
  - `/_global-error` is a non-cacheable 404;
  - build-asset misses are plain-text 404s with no HTML.
  - Proven to bite: with a narrower matcher (`/((?!_next/|.*\..*).*)`, as written in a TypeScript string: `'/((?!_next/|.*\\..*).*)'`), the matcher unit test, five matcher-coverage e2e tests and the CI header check all fail.
- **Negative e2e:** the document is intercepted and seven payloads are injected: an inline script, an `onerror` handler, a `javascript:` link, an `evil.example` script, a same-origin chunk, a style attribute and a `<style>` element. None takes effect, exactly seven enforced violations fire, and the app keeps working.
- **Shared fixture (`tests/e2e/fixtures.ts`).** Every e2e test fails on any CSP violation or CSP console message, any request off the origin, any console or page error, or any unexpected error response.
- **Retries cannot hide a CSP failure.** CI retries a failed test once. `csp.spec.ts` runs with `retries: 0`. For every other test, the fixture records a CSP violation on disk, and any retry of that test fails with it.
- **Tests wait for hydration, not timing.** WalletProviders sets `data-hydrated` on `<html>` from a mount effect, which runs after every child effect. Tests wait for it before using the keyboard.
- **CI (`pnpm --filter @ranvier/web check:headers`).** Starts the standalone `server.js` three times:
  - enforcing, with hostile runtime `NEXT_PUBLIC_API_URL` and `RANVIER_BUILD_API_ORIGIN` values that must change nothing;
  - with `CSP_REPORT_ONLY=1 RANVIER_ENV=staging` (Report-Only plus a warning);
  - with `CSP_REPORT_ONLY=1 RANVIER_ENV=production` (ignored, enforced, plus a warning).

  Each time it checks the pages and probe paths (twice each), HEAD and POST, `/_global-error`, and build-asset misses.

## Consequences

- Every new screen is rendered per request and gets the nonce automatically. Add it to `tests/e2e/routes.ts` so the CSP and axe tests cover it.
- No new script origin, no `'unsafe-eval'` or `'wasm-unsafe-eval'` (some Solana libraries need it), no `style` prop and no `dangerouslySetInnerHTML`. Any exception needs an ADR.
- Token logos are served from our own origin. `img-src` is never widened to `https:`.
- A Next upgrade can change how nonces are applied. The e2e suite and the CI header check fail if it does.
- A cached HTML response would reuse a nonce. The runbook forbids caching HTML at Caddy and Cloudflare.
- **Rate limiting is a hard pre-production requirement.** Every page is rendered per request and HTML cannot be cached, so a request for any made-up path costs about as much as `/`. Measured on one process: about 420 req/s for a random 404, against about 5,750 req/s for a static miss. Production must not go live without per-IP limits and burst challenges at the edge, sized Node workers and a passing load test (`docs/runbooks/web-deployment-headers.md`, "Rate limiting"; the API's own limits are in `docs/runbooks/edge-rate-limiting.md`).
- HSTS with `includeSubDomains; preload` is already served. Every subdomain must serve HTTPS before the first production deploy, not only before the preload submission.

### What the first signing PR must assume

- The policy is enforced, not Report-Only, in every environment, and `csp.spec.ts` and the CI header check are green.
- **Release gate:** the release checklist in `docs/runbooks/web-deployment-headers.md` passes against production:
  - the enforcing `Content-Security-Policy` header is present and there is no Report-Only header;
  - neither `CSP_REPORT_ONLY` nor `RANVIER_ENV=staging` is set, and the server log has no `[security]` line;
  - the rate limits are active and the load test shows them.
- No new script origin and no `unsafe-*` source. A wallet SDK, WalletConnect or WebHID support is its own ADR, with the exact origins and header changes it needs (for example `same-origin-allow-popups`, `hid=(self)`).
- `connect-src` stays `'self'` plus the API origin; chain reads go through the API.
- The review and sign screens are new routes in `tests/e2e/routes.ts`. They contain no inline handlers, `dangerouslySetInnerHTML` or `style` props.

## References

- `docs/runbooks/web-deployment-headers.md`
- Next.js 16.4 guide "Content Security Policy" (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`)
- ADR 0007 (wallet connection)

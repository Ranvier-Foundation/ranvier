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

  | Build               | p50, sequential  | Throughput at 20 concurrent |
  | ------------------- | ---------------- | --------------------------- |
  | Before (static)     | 4.7 to 5.3 ms    | about 865 req/s             |
  | After (per request) | figure in the PR | figure in the PR            |

  This is acceptable for this app. HTML for a wallet app should not be cached at the edge anyway: a cached page would reuse a nonce.

- Next marks these pages `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`. Caddy and Cloudflare must never cache HTML or change that header (runbook below).

### The policy

```
default-src 'none'; script-src 'nonce-{N}' 'strict-dynamic' 'report-sample'; style-src 'self' 'nonce-{N}'; img-src 'self' data:; font-src 'self'; connect-src 'self' {API_ORIGIN}; manifest-src 'self'; worker-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
```

- **No `'unsafe-inline'`, no `'self'` and no host in `script-src`.** Only nonced scripts, and what they load, run. `'report-sample'` adds the first characters of a blocked script to the violation.
- **`style-src` has no `'unsafe-inline'`.** The app emits no inline style (PR #22: ESLint forbids the `style` prop, `<style>` and `dangerouslySetInnerHTML`; the app has its own 404 and global-error pages).
- **`next dev` only:** `'unsafe-eval'` for scripts (React rebuilds server error stacks with `eval`) and `style-src 'self' 'unsafe-inline'`, because Turbopack's dev CSS loader injects un-nonced `<style>` elements (33 violations measured without it). A production build never contains `unsafe-*`; unit tests, e2e tests and the CI header check all assert this.
- **`{API_ORIGIN}`** is validated by `apiOrigin()`, unchanged: an http(s) origin only, https in production except loopback. next.config.ts calls it, so a bad `NEXT_PUBLIC_API_URL` fails the build.
- **`CSP_REPORT_ONLY=1`** (exactly, read at runtime) sends the same policy as `Content-Security-Policy-Report-Only` instead. It exists for a first run on staging behind the real proxy and CDN. Any other value enforces.

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
  - the proxy drops client-sent CSP headers, uses a new nonce per request and honours `CSP_REPORT_ONLY`;
  - the static headers, and every `apiOrigin()` case, including a bad value failing next.config.ts.
- **e2e (`tests/e2e/csp.spec.ts`, production build), on every route in `tests/e2e/routes.ts` and on the 404:**
  - the exact header, a different nonce on a second request, the nonce on every `<script>`, `private, no-store`;
  - zero violations and zero CSP console messages at 1440 and 390 px; through the connect dialog, a connected wallet, the wallet and network menus and a reload; and through a client-side navigation that loads a new chunk with Next's loader (404 to "Back to Swap").
- **Negative e2e:** the document is intercepted and seven payloads are injected: an inline script, an `onerror` handler, a `javascript:` link, an `evil.example` script, a same-origin chunk, a style attribute and a `<style>` element. None takes effect, exactly seven enforced violations fire, and the app keeps working.
- **Shared fixture (`tests/e2e/fixtures.ts`).** Every e2e test fails on any CSP violation or CSP console message, any request off the origin, any console or page error, or any unexpected error response.
- **CI (`pnpm --filter @ranvier/web check:headers`).** Starts the standalone `server.js` twice (enforcing, then with `CSP_REPORT_ONLY=1`) and checks the headers, the nonce change and the nonce on every `<script>`.

## Consequences

- Every new screen is rendered per request and gets the nonce automatically. Add it to `tests/e2e/routes.ts` so the CSP and axe tests cover it.
- No new script origin, no `'unsafe-eval'` or `'wasm-unsafe-eval'` (some Solana libraries need it), no `style` prop and no `dangerouslySetInnerHTML`. Any exception needs an ADR.
- Token logos are served from our own origin. `img-src` is never widened to `https:`.
- A Next upgrade can change how nonces are applied. The e2e suite and the CI header check fail if it does.
- A cached HTML response would reuse a nonce. The runbook forbids caching HTML at Caddy and Cloudflare.

### What the first signing PR must assume

- The policy is enforced, not Report-Only, in every environment, and `csp.spec.ts` and the CI header check are green.
- No new script origin and no `unsafe-*` source. A wallet SDK, WalletConnect or WebHID support is its own ADR, with the exact origins and header changes it needs (for example `same-origin-allow-popups`, `hid=(self)`).
- `connect-src` stays `'self'` plus the API origin; chain reads go through the API.
- The review and sign screens are new routes in `tests/e2e/routes.ts`. They contain no inline handlers, `dangerouslySetInnerHTML` or `style` props.

## References

- `docs/runbooks/web-deployment-headers.md`
- Next.js 16.4 guide "Content Security Policy" (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`)
- ADR 0007 (wallet connection)

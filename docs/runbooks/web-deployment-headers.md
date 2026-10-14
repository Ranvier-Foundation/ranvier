# Runbook: web security headers in deployment

The web app's security headers come from the app itself (ADR 0008):

- **The Content-Security-Policy** comes from `apps/web/src/proxy.ts`, with a new nonce on every request.
- **All other headers** (HSTS, nosniff, frame, referrer, permissions, COOP, CORP) come from `apps/web/next.config.ts`.

Everything in front of the app (Caddy or Nginx, then Cloudflare) must pass them through untouched. Anything that caches HTML or injects scripts into it breaks the policy, or weakens it silently.

## Settings

| Variable              | When it is read | Effect                                                                                                                                                                                                                             |
| --------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | **Build only**  | Its origin goes into `connect-src`. Validated at build (a bad value fails the build) and baked in as `RANVIER_BUILD_API_ORIGIN`. Setting either variable on the running server changes nothing. To change the API origin, rebuild. |
| `CSP_REPORT_ONLY`     | Server start    | `1` (exactly) sends the policy as Report-Only, but **only** together with `RANVIER_ENV=staging`.                                                                                                                                   |
| `RANVIER_ENV`         | Server start    | `staging` (exactly) is the only value that allows Report-Only. Production does not set it, or sets anything else.                                                                                                                  |

The server logs one warning line at start, prefixed `[security]`, whenever `CSP_REPORT_ONLY=1` is set:

- with `RANVIER_ENV=staging`: `CSP IS NOT ENFORCED: …` (Report-Only is active);
- with anything else: `CSP_REPORT_ONLY=1 IGNORED: … ENFORCED` (the stray flag has no effect, and the policy is enforced).

Either line in a production log means the environment is misconfigured. Remove the variable.

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

- **Never expose the origin except to Cloudflare.** Firewall the origin so it only accepts Cloudflare's IP ranges (https://www.cloudflare.com/ips/). Otherwise a client can bypass Cloudflare's limits and challenges entirely.

## Allowed

- Cache `/_next/static/*` at the edge for as long as you like. These files are immutable (`Cache-Control: public, max-age=31536000, immutable`), and Next sends no CSP on them. A miss there is a plain-text 404 that is never HTML, so it needs no policy.
- Compression (gzip or brotli) of responses.
- A Cloudflare challenge page (bot or DDoS) is a separate response from Cloudflare, so it does not need our policy.
- `/_global-error` needs no rule in Caddy or Cloudflare. The app's proxy answers a direct request for it (`/_global-error`, `.html`, `.rsc`, with or without `X-Forwarded-Proto: https`) with a plain-text `404` and `Cache-Control: no-store`. Next's prerendered error page there was cacheable (`s-maxage=31536000`) and had no nonces.
  - An earlier version rewrote the request to the 404 page instead. Behind a TLS-terminating proxy, that rewrite was built as an `https://` URL, which Next fetched as an external URL from its own plain-HTTP port: a 500, an EPROTO stack trace and an outbound socket per request.
  - CI now checks these paths with forwarded headers (`check:headers`, `csp.spec.ts`).

## Rate limiting (hard pre-production requirement)

**Production must not go live without this.** Every page is rendered per request (that is how it gets its nonce), and HTML cannot be cached. A request for any made-up path costs as much as the home page.

Measured on one Node process, loopback, 20 concurrent, with `scripts/bench.mjs`:

| Request                | Throughput             |
| ---------------------- | ---------------------- |
| `/`                    | about 230 to 360 req/s |
| A random 404           | about 420 req/s        |
| A `/_next/static` miss | about 5,750 req/s      |

One client with a loop can therefore saturate a process. The API has its own list in [edge-rate-limiting.md](edge-rate-limiting.md). Both run at the same edge (Cloudflare, then Caddy), key on the same real client IP, and answer `429` with `Retry-After`.

Do all of the following.

**Per-IP limit on every request except real build-asset files.** One page view costs one document request plus the RSC prefetches for every visible nav link (7 today), so roughly 8 to 10 requests. Start at **300 requests per minute per IP**, check it against real browsing on staging, and tighten it if you can.

**Exempt only real static files, and only after URL normalisation.** A raw prefix exemption (`/_next/static/*`) can be bypassed. Next resolves dot segments, so `/_next/static/%2E%2E/%2E%2E/` renders the full home page (200, 23 scripts, measured), and `/_next/static/%2e%2e/x` renders the 404 page: unlimited full renders behind an "exempt" prefix. Therefore:

- Prefer to limit everything and exempt only requests that are certainly a build file: a path of plain segments ending in a file name with an asset extension, and containing no `%` or `..` (the regex in the example below). Anything else falls under the limit.
- **Cloudflare:** keep **Normalize incoming URLs** turned on (Rules, Settings, URL normalization), so rule expressions see the normalised path, and keep `contains ".."` and `contains "%"` in the exemption anyway.
- **Caddy:** whether its matchers see `%2E%2E` decoded or cleaned depends on the version. Do not rely on it: use the strict regex, then prove it with the dot-segment load test below, which must hit the limit.

Caddy has no built-in rate limiter. It needs the `github.com/mholt/caddy-ratelimit` plugin, built in with `xcaddy build --with github.com/mholt/caddy-ratelimit`. The example below is unverified (written without a Caddy build); test it on staging with the load test before relying on it:

```caddyfile
{
	order rate_limit before reverse_proxy
	servers {
		# Behind Cloudflare: trust only its ranges, take the client IP from its header.
		trusted_proxies static <Cloudflare IPv4 and IPv6 ranges>
		client_ip_headers CF-Connecting-IP
	}
}

app.example.com {
	rate_limit {
		zone web_pages {
			match {
				# Everything except a real build file: no dots in directories, no % or "..".
				not path_regexp ^/_next/static/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|woff2|png|svg|ico|map|txt)$
			}
			# One key per client address. IPv6 is keyed per /128 (see "IPv6" below).
			key {client_ip}
			events 300
			window 1m
		}
	}
	# Defensive: responses Next builds before its own headers (308 redirects, a crashed proxy)
	# get HSTS and nosniff too. `?` sets a header only when the app did not; never touch CSP here.
	header ?Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
	header ?X-Content-Type-Options "nosniff"
	# TRACE has no use here; Next answers it with a plain-text 500 (no HTML, no CSP).
	@trace method TRACE
	respond @trace 405
	reverse_proxy 127.0.0.1:3001 127.0.0.1:3002 127.0.0.1:3003 127.0.0.1:3004 {
		lb_policy least_conn
	}
}
```

The alternative, or an additional layer, without a Caddy plugin is a Cloudflare WAF rate limiting rule. Which periods and actions are available depends on the Cloudflare plan:

- Expression: `(http.host eq "app.example.com" and not (starts_with(http.request.uri.path, "/_next/static/") and not http.request.uri.path contains ".." and not http.request.uri.path contains "%"))`, with URL normalisation on.
- Counting characteristic: IP.
- Threshold: the same budget (for example 50 requests per 10 seconds), action Block, with a mitigation timeout.

**IPv6.** `key {client_ip}` counts each IPv6 address (/128) separately, and anyone with an ordinary /64 has effectively unlimited addresses. Caddy's placeholders cannot truncate an address to a prefix, and the plugin has no option for it (as far as known; check the plugin's current README). So per-prefix limiting must come from Cloudflare: use a rate-limiting characteristic that groups IPv6 by /64 if your plan offers one. Otherwise rely on the global ceiling (a rule without a per-IP characteristic, sized to total capacity), on Bot Fight mode, and on Under Attack mode during an incident. A Caddy per-IP limit alone is not enough for IPv6.

**Challenge on bursts.** Add a second, lower Cloudflare rule (for example 30 requests per 10 seconds per IP on the same expression) with the action Managed Challenge, so a burst meets a challenge before the hard block. Turn on Under Attack mode during an incident.

**Size the Node workers.** `server.js` is one process. Run one per CPU core, each on its own `PORT`, behind `reverse_proxy` as above. Capacity is roughly the number of processes times the throughput measured on the target hardware with the load test below. Set the per-IP limit well below one process's capacity, and alert on sustained 429s and on CPU above 70%.

**Verify with a load test,** from one machine against staging (only hosts you operate):

```sh
H=staging.example.com
node apps/web/scripts/bench.mjs "https://$H/" 2000 20 --allow-host $H
node apps/web/scripts/bench.mjs "https://$H/made-up-$RANDOM" 2000 20 --allow-host $H
# Dot segments under the exempt prefix render full pages: this must hit the limit too.
node apps/web/scripts/bench.mjs "https://$H/_next/static/%2E%2E/%2E%2E/" 2000 20 --allow-host $H
```

`bench.mjs` refuses any host other than localhost, `127.0.0.1` or `[::1]` unless `--allow-host` names it exactly.

- Expected: `statuses` contains `429` (or Cloudflare's challenge or block status) once the budget is used up, and the rest are 200 or 404.
- Without the limiter, all 2,000 succeed. That result is a release blocker.
- The same command against `http://127.0.0.1:<port>/` measures one process for sizing.

## Verify after every deploy

```sh
H=https://<web-host>
# Enforced policy, nonce changes per request, page not cacheable, no Report-Only header at all.
for i in 1 2; do curl -sI "$H/" | grep -iE '^(content-security-policy|cache-control|strict-transport-security|cross-origin)[a-z-]*:'; done
curl -sI "$H/" | grep -iq '^content-security-policy:' && echo "OK: enforced CSP present" || echo "FAIL: no enforced CSP"
curl -sI "$H/" | grep -iq '^content-security-policy-report-only:' && echo "FAIL: Report-Only header present" || echo "OK: no Report-Only header"
# A made-up path is also under the policy.
curl -sI "$H/robots.txt" | grep -iq '^content-security-policy:' && echo "OK: 404 under the policy" || echo "FAIL: 404 without CSP"
# A static asset: immutable, no CSP.
curl -sI "$H$(curl -s "$H/" | grep -o '/_next/static/chunks/[^"]*\.js' | head -1)" | grep -iE '^(cache-control|content-security-policy|cf-cache-status):'
```

The grep patterns end in `:` on purpose. `^content-security-policy` alone also matches `content-security-policy-report-only` and would hide a Report-Only deployment.

Expected:

- Two different `'nonce-…'` values.
- `script-src 'nonce-…' 'strict-dynamic' 'report-sample'`, with no `unsafe-` anywhere.
- Three `OK` lines.
- No `cf-cache-status: HIT` on the page.
- `Cache-Control` containing `private` and `no-store`.
- No `[security]` line in the server log.

Then open the site in a browser with DevTools, connect a wallet, and check the console shows no "Content Security Policy" messages. In CI, `pnpm --filter @ranvier/web check:headers` runs these checks against the standalone server, including the probe paths and both Report-Only cases.

## Release checklist

For every production release, and as a **blocking** gate for any release that includes signing or transactions:

- [ ] The enforcing `Content-Security-Policy` header is present on the release (verification above, run against production), and there is no `Content-Security-Policy-Report-Only` header.
- [ ] Neither `CSP_REPORT_ONLY` nor `RANVIER_ENV=staging` is set in the production environment, and the server log has no `[security]` line.
- [ ] The rate limits above are active, and the load test shows 429s or challenges for `/`, for a made-up path **and** for `/_next/static/%2E%2E/%2E%2E/`.
- [ ] `TRACE /` is refused at the proxy (`curl -s -o /dev/null -w '%{http_code}' -X TRACE "$H/"` prints `405`, or Cloudflare's block status).
- [ ] CI was green on the released commit, including `check:headers` and `csp.spec.ts`.

## First rollout: Report-Only

1. Deploy to **staging** with `RANVIER_ENV=staging` and `CSP_REPORT_ONLY=1`. The same policy is sent as `Content-Security-Policy-Report-Only`, so violations are logged in the browser console without blocking anything. The server logs `[security] CSP IS NOT ENFORCED` at start.
2. Use the site through the proxy and CDN: every screen, connect a wallet, switch networks, reload. Check the console for `[Report Only]` CSP messages; there must be none. (A report endpoint is a later change. Until then, the console is the only report.)
3. Remove `CSP_REPORT_ONLY`, redeploy and verify as above.

Production always enforces: `CSP_REPORT_ONLY=1` without `RANVIER_ENV=staging` is ignored.

## Responses without the static headers

Two kinds of response carry none of the next.config.ts headers (HSTS, nosniff and so on):

- the 308 redirect Next sends for a trailing slash (`/trade/` to `/trade`);
- the plain 500 Next sends if the proxy itself throws.

Neither is exploitable:

- **No document.** Neither response has an HTML document or scripts from us. The browser either follows the `Location` at once, where the target carries every header, or shows a bare error.
- **HSTS still applies.** The browser keeps HSTS from any earlier HTTPS response.
- **The proxy has little left to fail on.** It no longer reads `NEXT_PUBLIC_API_URL` at runtime (that could once make it throw on every request), and it no longer rewrites (a rewrite once produced a 500 behind a TLS proxy). If it does throw, the result is still a bare 500 with no document.

`TRACE /` also returns a plain-text 500 without CSP. It is not HTML, so nothing runs; block `TRACE` at the proxy anyway (Caddy example above).

The `header ?…` lines in the Caddy example add HSTS and nosniff to these responses anyway.

## DNS and HSTS

- **DNSSEC:** enable it in Cloudflare and publish the DS record at the registrar. Check with `dig +dnssec <domain>` (look for `ad` and RRSIG records).
- **HSTS is already served with `includeSubDomains; preload`.** As soon as the production domain answers once, browsers require HTTPS for **every subdomain** for two years. Every subdomain must serve HTTPS **before the first production deploy**, not only before the preload submission.
- **Preload submission:** submit the domain at hstspreload.org only once the production domain exists and the point above holds. Leaving the list later takes months.
- Keep `max-age=63072000; includeSubDomains`. Never lower it once deployed.

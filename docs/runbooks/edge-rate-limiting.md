# Runbook: rate limiting at the edge (API) (TODO)

Status: **not implemented**. A hard requirement before any public deployment: production must not go live without it.

This runbook covers the API. The web app has its own limits, which are just as mandatory, in [web-deployment-headers.md](web-deployment-headers.md#rate-limiting-hard-pre-production-requirement). Every web page is rendered per request, so unthrottled requests for made-up paths are as expensive as the home page. Both are enforced at the same edge in the same way:

- Cloudflare WAF rate limiting rules in front, then Caddy with the `caddy-ratelimit` plugin at the origin.
- The key is the real client IP. Caddy trusts only Cloudflare's ranges and reads `CF-Connecting-IP`; the origin firewall accepts only Cloudflare.
- Over the limit, answer `429` with `Retry-After`.
- Verify with `node apps/web/scripts/bench.mjs <url> 2000 20 --allow-host <host>` from one machine; it counts responses by status code and refuses hosts that are not named.
- Normalise URLs before matching (Cloudflare "Normalize incoming URLs" on), and limit IPv6 per /64 at Cloudflare, because Caddy keys per address (see the web runbook).

The quote API has no built-in rate limiting. Each `POST /v1/quotes` can trigger paid upstream calls (0x) and price-oracle lookups. Unlimited traffic can therefore exhaust the 0x quota or run up costs, and can degrade quotes for everyone.

Rate limiting belongs at the edge (reverse proxy or WAF in front of the self-hosted API), not in the API process:

- [ ] Per-client-IP limit on `/v1/quotes` (starting point: 1 request per second sustained, burst 10) and a lower global ceiling sized to the 0x plan.
- [ ] Per-client-IP limit on `/v1/fees/preview` (cheap, but keep it bounded).
- [ ] Per-client-IP limit on `POST /v1/balances` (starting point: 2 requests per second sustained, burst 10) **and** a global ceiling for the route sized to the RPC plan. Both are a release gate (ADR 0009). Each request costs two paid RPC requests, more on failover. The API merges identical requests, reuses a wallet's balances for 3 s and caps reads per chain (8 running, 32 waiting, then `503`), but a client cycling through addresses bypasses the cache: one client can hold every chain's limiter full (legitimate users get `503`) and spend about 55 RPC requests per second per chain, roughly 14 million a day across three chains. Key limits on the client IP only. **Never log request bodies for this route** at Cloudflare, the WAF or Caddy: the body holds the wallet address (personal data). The endpoint is a POST so that URLs, which every layer logs, carry no address.
- [ ] Return `429` with `Retry-After`; never forward rate-limited requests upstream.
- [ ] Request body size is already capped at 16 KiB by the API (`413 payload_too_large`); keep the edge cap at or below that.
- [ ] Alert on sustained 429s and on the 0x quota approaching its limit.
- [ ] Decide on per-wallet limits once wallets authenticate (not before: `taker` is client-supplied and free to vary).
- [ ] Load test each limited route on staging with `bench.mjs` (POST routes need a body; adapt the request) and confirm 429s appear once the budget is used up.

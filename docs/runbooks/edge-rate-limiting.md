# Runbook: rate limiting at the edge (TODO)

Status: **not implemented**. Required before any public deployment.

The quote API has no built-in rate limiting. Each `POST /v1/quotes` can trigger paid upstream calls (0x) and price-oracle lookups. Unlimited traffic can therefore exhaust the 0x quota or run up costs, and can degrade quotes for everyone.

Rate limiting belongs at the edge (reverse proxy or WAF in front of the self-hosted API), not in the API process:

- [ ] Per-client-IP limit on `/v1/quotes` (starting point: 1 request per second sustained, burst 10) and a lower global ceiling sized to the 0x plan.
- [ ] Per-client-IP limit on `/v1/fees/preview` (cheap, but keep it bounded).
- [ ] Return `429` with `Retry-After`; never forward rate-limited requests upstream.
- [ ] Request body size is already capped at 16 KiB by the API (`413 payload_too_large`); keep the edge cap at or below that.
- [ ] Alert on sustained 429s and on the 0x quota approaching its limit.
- [ ] Decide on per-wallet limits once wallets authenticate (not before: `taker` is client-supplied and free to vary).

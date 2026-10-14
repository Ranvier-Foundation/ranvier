# ADR 0009: Wallet balances through the API

- Status: accepted
- Date: 2026-10-14

## Context

The token picker needs the connected wallet's balances. ADR 0008 recorded the owner's decision that the browser never talks to an RPC provider: chain reads go through `apps/api`, so the web CSP stays `connect-src 'self' <api origin>`, RPC keys stay on the server, and we control rate limits, caching and failover. Spec section 9 asks for several providers per chain with automatic failover and health scoring.

This ADR covers the API side. The web UI that calls it comes in a later change.

## Decision

### Shape (hexagonal)

- **Port** `apps/api/src/ports/chain-reader.ts`: `ChainReader.readBalances({ chainId, owner, tokens }, signal)` returns the native balance and one `balanceOf(owner)` per token, all at **one block**, plus that block number. Failures are a `ChainReadError` with a stable code (`rpc_unavailable`, `timeout`) and a short fixed reason for logs.
- **Adapter** `apps/api/src/adapters/rpc/viem-chain-reader.ts`: viem 2.56.9 (already a dependency of the API). No new dependency.
- **Service** `apps/api/src/domain/balances.ts`: `BalanceService` picks the tokens, caches, merges and bounds reads.
- **Route** `apps/api/src/http/balances.ts`: `POST /v1/balances`.

### Endpoints and failover

- Endpoints come from `RPC_URLS_EVM_<chainId>` (comma-separated, in preference order, at most 8). They are validated at startup: https only, plain http only for a loopback host, no empty entry, no duplicate (compared after URL normalisation, so `https://a` and `https://A/` are one), no fragment (not even a bare `#`), and a variable named `RPC_URLS_EVM_<anything else>` fails startup. Errors name the variable and entry number, never the value. A variable for a chain without balances is ignored with a warning naming it.
- Without the variable, a chain uses the public development endpoints in `@ranvier/chains` (`PUBLIC_RPC_URLS`: publicnode and 1RPC), and startup logs a warning naming the chain. These must never be used in production (privacy, rate limits, no agreement). The runbook makes this a release check.
- Each chain's endpoints sit behind viem's `fallback` transport. An endpoint that errors or times out (per-request timeout `RPC_REQUEST_TIMEOUT_MS`, default 1.5 s) hands the request to the next one. The timeout covers the whole exchange, body included: viem's own timeout ends when the headers arrive, so an endpoint that sent `200` and part of a body, then stalled, used to hold a read until the 3 s deadline with no failover (found in re-review, reproduced at 3,010 ms). Each fetch now also carries its own per-request timeout signal (the proof's 5 s for `eth_chainId` proofs), which aborts the body stream; the read fails over, ranking pings cannot freeze, and if every endpoint stalls the answer is `504 timeout`. Retries are bounded (one more pass, 100 ms base delay) and only for transient errors (viem's `shouldRetry`: timeouts, 429, 5xx, rate-limit codes). A deterministic error (a revert, invalid params) is neither retried nor sent to the next endpoint.
- **Redirects are refused.** Every RPC request, reads and chain ID proofs alike, is sent with `redirect: 'error'`, and any 3xx that still reaches the adapter is refused. Node's fetch follows redirects by default: a security review showed a 302 making the API fetch an internal host, and a 307 re-POSTing the JSON-RPC body (with the wallet address) to another host whose answer was then served as balances, bypassing the chain ID proof. A redirecting endpoint now counts as failed (the fallback moves on), and the log names its label with `reason: redirect`. The API host must also have an egress firewall (runbook).
- **No outbound call of the API follows a redirect.** The 0x quote and DefiLlama price fetches have the same rule (`apps/api/src/lib/redirect.ts`): across origins Node's fetch strips only `Authorization`, so following a redirect would have sent the `0x-api-key` header to the redirect's host. A redirect there is an upstream failure with a fixed reason (`0x redirect refused`: `upstream_error`; `DefiLlama redirect refused`: no price), never a URL. These are all the outbound HTTP clients of `apps/api`; AWS KMS uses the AWS SDK's own client, and `apps/workers` makes no outbound calls yet.
- **Health scoring:** viem's `rank` samples every endpoint with `eth_blockNumber` every `RPC_RANK_INTERVAL_MS` (default 30 s, 0 turns it off), and orders them by stability (weight 0.7) and latency (0.3) over the last 10 samples.
- **Chain ID proof.** An endpoint serves nothing until it has answered `eth_chainId` with its configured chain (lesson from the `verify:tokens` review: cbBTC has one address on three chains, so a mis-pointed RPC would return plausible balances for the wrong chain). The fetch of an unproven endpoint is refused locally, so viem moves to the next one. An endpoint that reports another chain to `eth_chainId` is dropped until restart and logged as an error. The proof has its own 5 s timeout, because a first request also pays for DNS and the TLS handshake. An endpoint that cannot be reached is asked again every 30 s and, while its chain has no proven endpoint, on a request at most every 10 s. Every multicall read also checks `block.chainid` inside the same `eth_call`. A mismatch fails the read, and the endpoint that answered that `eth_call` (recorded per read) is dropped and logged by label, the others keep serving. It is dropped for 60 s, doubled on every repeat up to 30 min, and must then prove its chain again; an endpoint that lies in calls cannot flap the whole chain to `503`.
- `GET /v1/chains` adds `balances: true|false` per chain: true when the chain has a curated token list and at least one proven endpoint right now. With no proven endpoint, `/v1/balances` answers `503 rpc_unavailable` for that chain. (`/v1/chains` keeps `Cache-Control: private, max-age=300`, so the flag can be up to five minutes old in a browser.)

### One block, one call

- The block number is read first (`eth_blockNumber`). Then one `eth_call` to Multicall3 `aggregate3` **pinned to that block** reads `getChainId()`, `getCurrentBlockTimestamp()`, `getEthBalance(owner)` and `balanceOf(owner)` for every token. All balances are therefore from one block, in one request.
- The block number is not taken from Multicall3's `getBlockNumber()`, because on Arbitrum `block.number` inside the EVM is an L1 block number. The two requests may reach different endpoints; an endpoint that does not have the block yet fails, and the fallback moves on.
- Multicall3 is used at its canonical address `0xcA11bde05977b3631167028862bE2a173976CA11` on chains whose viem definition lists it there: Ethereum, Base and Arbitrum One (checked by a test, and live by the smoke script).
- **Without Multicall3** (a future chain; none of the three served chains uses it), the adapter sends one request per balance, every one pinned to the same block number, plus `eth_chainId` and `eth_getBlockByNumber` for the plausibility checks, at the cost of N + 3 requests. It is **weaker** than the one-call path: each request goes through the fallback on its own, so the chain ID and block checks cover the endpoint that answered them, not necessarily the endpoints that answered the balances (all proved endpoints, all pinned to the same block number). That is why it is the fallback only.
- **Per-token isolation:** every token call has `allowFailure: true`. A token whose call reverts, that has no code, or that returns anything but exactly one 32-byte word is `null`; the rest are still returned. The calls to Multicall3's own chain ID and timestamp must succeed. In the individual-call fallback only a revert is `null`; any other error fails the whole read, so an outage never looks like empty balances.

### What a lying or broken RPC can do

Balances are **display data**. They are never used for fees, route vetting or signing. The fee tier comes from the oracle and the request amount, the route is vetted against the signed quote, and the fee wrapper's on-chain checks (signed fee, allowlisted router, bound calldata, minimum output by balance difference) govern money. A lying RPC can therefore mislead the picker; it cannot move funds.

What we check, to catch buggy, lagging or mis-pointed providers:

- shapes: every quantity is canonical hex (`0x0` or no leading zero) of at most 64 digits, so never above 2^256 - 1; every `uint256` return is exactly 32 bytes; the `aggregate3` result must decode and have exactly one result per call; the block number must be between 1 and 2^53;
- the chain: `eth_chainId` before use, and `block.chainid` inside every read;
- the host: no redirect is followed;
- the block: its timestamp may not be more than 60 s in the future (this depends on the API host's clock, so the host runs NTP) or 300 s old; it may not be more than 30 s older than the newest block seen on the chain; and a lower block number with a much later timestamp is refused. The newest block is forgotten after 60 s, so one bad answer cannot block a chain for longer;
- size: response bodies are capped at 256 KiB, and the token list is the curated one (about ten tokens per chain), never client-supplied.

A malicious provider can still return a consistent lie. Multi-provider quorum reads would catch that and are not built; choosing reputable providers is the control (runbook).

**Note for the review screen (later):** before a user signs, the amounts shown must come from the wallet and a transaction simulation (`eth_call` of the exact fee-wrapper transaction, or the wallet's own preview), not from these balances. That simulation will add: the real input and output amounts after fee, a revert reason before the user signs, and a check that the user can pay. It runs against our own RPCs with the same chain-ID proof.

### The endpoint

`POST /v1/balances` with `Content-Type: application/json` and the body `{ "chain": "evm:1", "address": "0x…" }`.

- **Why POST.** The address is personal data. URLs are logged by every layer by default (reverse proxies, CDNs, WAFs, browser history, `Referer`), request bodies are not. A first version used `GET` with a query string; the security review asked for the change before the web UI depends on it. Body logging must still be off at the edge and WAF for this route (runbook).
- `GET` (and the `HEAD` Fastify derives from it) answers `405 {"error":"method_not_allowed"}` with `Allow: POST` and never reads.
- Strict body schema: exactly `chain` and `address`, both strings; unknown keys are `400 invalid_request` with field paths only. The body must be `application/json` (with any parameters, such as a charset); anything else is `415 {"error":"invalid_request"}`. Bodies over 1 KiB are `413 payload_too_large`. A request cannot name an RPC URL; endpoints come from the environment only.
- `chain` must be a served EVM chain (`ZEROX_CHAIN_IDS`) with a curated token list.
- `address` is a 20-byte hex address in **any letter case**. There is no EIP-55 checksum check: the data is public and read-only, and the web app sends the connected wallet's own address, so a typo only shows another account's public balances. It is lowercased at the edge and never echoed in its raw form. The zero address and `0xeeee…eeee` are refused: they are native-coin placeholders, not wallets. Contract addresses (smart wallets) are allowed.
- Answer: `{ chain, address, blockNumber, balances: [{ address: 'native' | '0x…', balance }] }`, with the native coin and **every** curated token of the chain in token-list order (one source: `listTokens` in `@ranvier/chains`; decimals are taken from `/v1/tokens`, not repeated here). `blockNumber` and `balance` are decimal strings of base units, like the rest of the API; `balance` is `null` when that one read failed.
- `Cache-Control: private, no-store` on every response of the route, errors included (a route `onSend` hook, so 413, 415 and malformed-JSON answers carry it too). Balances are per wallet and must never be stored by a shared cache or the browser. CORS and `Vary: Origin` work as for every route (ADR 0006): `POST` with the `content-type` header was already granted to the web origins for `/v1/quotes`, so the preflight works from an allowed origin and gets no grant from any other; nothing was widened.
- Errors: `400 invalid_request`, `405 method_not_allowed`, `413 payload_too_large`, `415 invalid_request`, `503 rpc_unavailable` (no proven endpoint, every endpoint failed, bad data, or the read queue is full), `504 timeout` (the deadline passed). Never a URL, provider text or the address.
- Fastify's own answer to a malformed URL (`/v1/balances%zz`) echoed the URL and skipped the error handler and hooks; `frameworkErrors` now answers `400 invalid_request` with `Cache-Control: no-store` and `Vary: Origin`, for every route.

### Load control

- A per-request deadline (`BALANCES_DEADLINE_MS`, default 3 s) covers queueing and every RPC request. A client that disconnects aborts its request too. The `AbortSignal` reaches every `fetch` the read makes (through viem, by async context), so an abandoned read stops its sockets and frees its limiter slot (tested with a raw socket that closes after 300 ms).
- Identical concurrent requests (same chain and lowercase address) share one read. A shared read keeps running while any caller waits, and is aborted when the last one leaves.
- A micro-cache keeps a successful answer for `BALANCES_CACHE_TTL_MS` (default 3 s), in an LRU of 5,000 entries. A failure is kept for 1 s. A sweep every second deletes expired entries, so an address stays in memory at most its TTL plus one second, whatever the traffic. A request refused because the queue is full, or a read every caller abandoned, is not cached.
- At most 8 reads run per chain and 32 wait (with the deadline as the longest wait); beyond that the answer is `503 rpc_unavailable` at once. One address spam therefore costs one read per 3 s, and many addresses cannot open more than 8 concurrent reads per chain (each read is 2 RPC requests, more on failover).
- **What the limits do not stop.** The cache and merging only help for repeated addresses. An attacker cycling through addresses bypasses both and can keep every chain's limiter full (8 running, 32 waiting), so legitimate users get `503`. At about 300 ms per read that is about 27 reads, so about 55 RPC requests per second per chain, roughly 14 million requests a day across the three chains, from one unauthenticated client.
- Therefore, **release gate**: per-client-IP limits on `/v1/balances` **and** a global ceiling for the route at the edge, sized to the RPC plan (docs/runbooks/edge-rate-limiting.md, docs/runbooks/rpc-providers.md).
- A per-client-IP concurrency cap inside the API was considered and left to the edge. Behind Cloudflare and Caddy the API sees the proxy's address; the real client IP comes from forwarded headers that are only trustworthy with a `trustProxy` set exactly to the proxy hops of the deployment, which does not exist yet. A cap keyed on the wrong address would either do nothing or throttle every user at once.

### Privacy

- A wallet address is personal data. A balance read reveals it to us and to the RPC provider that serves it (and, through the provider, possibly links it to our server's IP and timing). Production uses providers with a written no-logging (or short-retention) policy for request payloads; the runbook lists what to check.
- The API never logs the address, the request body or the query string. Fastify does not log bodies. Its default request serializer logs `req.url` with the query; it is replaced, for **every** route, by one that logs the path only (`requestLogSerializer` in `apps/api/src/http/server.ts`). Client errors (4xx) are logged by error name and code only, never by message. Fastify 5's own parser errors carry fixed messages today, but a message may quote request data (a future parser, plugin or route); a test pins the rule with an error whose message holds an address. The chain reader logs chain IDs, endpoint labels (`RPC_URLS_EVM_1[0]`), fixed reasons and error class names, HTTP statuses and JSON-RPC codes only, never an error message (viem messages quote the URL and the request body, which holds the address). Tests capture the log stream (success, invalid, malformed, oversized, wrong content type, `GET`, bad URL, failed and unexpected requests) and check that the address never appears.
- No analytics. The micro-cache holds addresses in memory for at most 4 s (TTL plus one sweep interval).

### Credentials

RPC URLs often carry an API key (in the path, the query or the user info). No URL is ever logged, returned or put in an error: startup errors name the variable, reader logs name the endpoint label, and responses carry stable codes only. `scrubUrls` (now shared from `@ranvier/chains`, `src/scrub.ts`, used by `verify:tokens` and the smoke script) replaces URL-looking text in anything printed. Tests run every failure mode (connection error, HTTP 500, HTTP 429, hang, revert, redirect, junk results) with URLs containing a fake key and check that neither the key nor the host appears in a response or a log line. viem sends URL user-info credentials as a Basic `Authorization` header.

## Consequences

- Balances add load and latency to our API, and depend on our RPC budget. The cache, merging and per-chain limits bound the concurrency, not the cost of an attacker cycling addresses; edge per-IP limits and a global ceiling are a release gate.
- A provider outage on every endpoint of a chain shows as `balances: false` and `503 rpc_unavailable`; quoting is unaffected (it does not use these RPCs).
- Production must set `RPC_URLS_EVM_<chainId>` for every served chain; the startup warning and the runbook release check catch a deployment that forgot.
- A malicious provider can show wrong balances. Accepted: display only, and the review screen will re-verify from the wallet and simulation.
- New EVM chains need a curated token list and RPC variables to get balances; a chain without Multicall3 in viem's definition gets the slower individual-call path automatically.
- `pnpm --filter @ranvier/api balances:smoke` is a manual live check (not in CI) against the configured or public endpoints.

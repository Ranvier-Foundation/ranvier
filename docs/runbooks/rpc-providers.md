# Runbook: RPC providers for balance reads

`POST /v1/balances` reads wallet balances through our own RPC endpoints, never from the browser (ADR 0008, ADR 0009). This runbook covers choosing providers, configuring them, rotating keys, health and outages.

Quoting and signing do not use these endpoints. An RPC outage costs balances in the token picker, nothing else.

## Choosing providers

Use at least two independent providers per chain (different companies, not two keys at one company), so one outage or one bad deploy does not take a chain down. For each provider, check and record in the deployment notes:

- **Logging and retention.** Every balance read sends the wallet address to the provider. Choose providers with a written policy of not logging request payloads, or of short retention (days, not months) without resale or analytics. Prefer an account-level "no logs" or "privacy" setting where offered.
- **Region and jurisdiction** of the endpoints you are given, if it matters for the deployment.
- **Rate limits and plan:** requests per second and per month. Each balance read costs 2 RPC requests (`eth_blockNumber` and one `eth_call`), more on failover; ranking adds one `eth_blockNumber` per endpoint every 30 s.
- **Methods:** `eth_chainId`, `eth_blockNumber`, `eth_call` with a block number (archive access is not needed: the block is the latest), and `eth_getBalance` and `eth_getBlockByNumber` for chains without Multicall3.
- **Key restrictions:** if the provider supports it, restrict the key to our server's egress IPs and to the methods above.
- **Status page and support contact.**

Never use the public development endpoints (`PUBLIC_RPC_URLS` in `packages/chains/src/rpc-defaults.ts`: publicnode and 1RPC) in production. They have no agreement, are rate-limited per IP and their logging is not ours to choose.

## Configuration

One variable per served chain, in preference order, comma-separated, at most 8 URLs:

```sh
RPC_URLS_EVM_1=https://<provider-1 Ethereum URL>,https://<provider-2 Ethereum URL>
RPC_URLS_EVM_8453=https://<provider-1 Base URL>,https://<provider-2 Base URL>
RPC_URLS_EVM_42161=https://<provider-1 Arbitrum URL>,https://<provider-2 Arbitrum URL>
```

- https only. Plain `http://` is accepted for `localhost`, `127.0.0.1` and `[::1]` only (a local node or an Anvil fork).
- Keys may sit in the path, the query or the user info (`https://user:key@host/...`; viem sends user info as a Basic `Authorization` header).
- Startup fails on an empty entry, a duplicate (compared normalised: `https://a` and `https://A/` are one), a fragment (even a bare `#`), a non-URL, a non-https URL, more than 8 URLs, or a variable named `RPC_URLS_EVM_<not a chain ID>`. The error names the variable and the entry number, never the value.
- A variable for a chain that is not served, or has no token list, is ignored and named in a warning.
- An unset variable falls back to the public development endpoints, with this startup warning (no URLs): `balance reads use PUBLIC development RPC endpoints for these chains: never in production`.
- Tuning (defaults are fine): `RPC_REQUEST_TIMEOUT_MS` (1500, per request per endpoint, response body included: an endpoint that stalls mid-body fails over after this), `RPC_RANK_INTERVAL_MS` (30000; 0 turns ranking off), `BALANCES_DEADLINE_MS` (3000), `BALANCES_CACHE_TTL_MS` (3000).

The values are secrets. Keep them in the secret store of the deployment, never in the repository, a ticket, a chat or a log. Do not paste them into a shell history on a shared host.

## API host requirements

- **Egress firewall.** The API host may open outbound connections only to the RPC providers, the other upstreams it needs (0x, DefiLlama, AWS KMS) and DNS/NTP. Deny at least: `169.254.0.0/16` (link-local, including the cloud metadata service at `169.254.169.254`), the RFC 1918 ranges `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`, `100.64.0.0/10`, loopback `127.0.0.0/8` and `::1` (except a local node explicitly allowed in development), IPv6 link-local `fe80::/10` and unique-local `fc00::/7`, and any other metadata or internal address of the hosting provider. RPC URLs come from the environment only, never from a request, but a mistyped or compromised provider hostname must not reach internal services.
- **Redirects are refused by design.** Every outbound request of the API (RPC, 0x, DefiLlama) is sent with `redirect: 'error'`; an RPC provider answering 3xx counts as failed and is logged as `RPC endpoint answered with a redirect; refused` with its label. Configure the final URL, never one that redirects.
- **NTP.** The host clock must be synchronised: a block whose timestamp is more than 60 s ahead of the host clock is refused (`block_in_future`), so a host clock that runs late refuses every read.

## Release check

Before every production release, on the production host:

- [ ] Every chain in `ZEROX_CHAIN_IDS` with a token list has its `RPC_URLS_EVM_<chainId>` set, with two or more providers.
- [ ] The startup log has no `PUBLIC development RPC endpoints` warning and no `RPC endpoint serves another chain` error.
- [ ] `GET /v1/chains` shows `"balances": true` for every served chain.
- [ ] The egress firewall above is in place, and NTP is synchronised (`timedatectl` shows `System clock synchronized: yes`).
- [ ] Per-IP limits and a global ceiling for `POST /v1/balances` are active at the edge, and request-body logging is off for the route ([edge-rate-limiting.md](edge-rate-limiting.md)).
- [ ] `pnpm --filter @ranvier/api balances:smoke` with the production variables in the environment (from the secret store, in a private shell) prints a recent block for every chain. It prints no URLs.

## Health checks and failover (what the API does)

- **Chain ID proof.** At startup every endpoint must answer `eth_chainId` with its chain before it serves anything. An endpoint that answers another chain is dropped until restart and logged as an error (`RPC endpoint serves another chain; dropped (check its env var)`, with the label such as `RPC_URLS_EVM_8453[1]`). Fix the variable and restart. One that cannot be reached is logged as `RPC endpoint unreachable; will retry` and asked again every 30 s (5 s timeout per attempt).
- **Failover.** A request that fails with a timeout, a connection error, HTTP 5xx or 429 or a rate-limit code moves to the next endpoint, then retries the whole list once.
- **Ranking.** Every 30 s each endpoint is sampled with `eth_blockNumber`; endpoints are ordered by stability and latency over the last 10 samples.
- **Redirects.** Never followed; a 3xx fails that endpoint for the request, and the next one serves.
- **Data checks.** Every read checks `block.chainid` (an endpoint that answers for another chain is dropped for 60 s, doubled on each repeat up to 30 min, then proved again), the block's age (300 s at most) and that it is not rewound against the newest block seen. A read that fails a check is refused (`balance read refused`, with the reason) rather than served.

Log fields to alert on (the log never holds URLs or wallet addresses):

| Log line                                           | Meaning                                                                                 | Action                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `RPC endpoint serves another chain` (error)        | A variable points at the wrong chain                                                    | Fix the variable now; restart                                                                                                          |
| `RPC answered a balance read for another chain`    | The endpoint in `endpoint` (e.g. `RPC_URLS_EVM_1[0]`) answered a read for another chain | Treat as a provider incident: remove that entry from the variable and roll; it is already dropped with a growing penalty (`penaltyMs`) |
| `RPC endpoint answered with a redirect` (warn)     | The provider redirects (moved URL, or tampering)                                        | Find the provider's current URL and update the entry; never point at a redirecting URL                                                 |
| `RPC endpoint unreachable` (warn), repeated        | Endpoint down or key revoked                                                            | Check the provider status page and the key                                                                                             |
| `balance read failed` with `status: 429` or `code` | Rate-limited                                                                            | Raise the plan or add a provider                                                                                                       |
| `balance read refused`, `stale_block`              | Provider lagging                                                                        | Check its status; demote it (move it later in the list)                                                                                |
| `balances unavailable` rate rises                  | Users see `503` or `504`                                                                | See "Provider outage"                                                                                                                  |

## Rotating a key

1. Create the new key at the provider (with the same IP and method restrictions).
2. Put the new URL in the secret store, replacing the old one in `RPC_URLS_EVM_<chainId>`, and roll the API (rolling restart; each process proves the new endpoint at startup).
3. Check the startup log for `RPC endpoint verified` with the endpoint's label, and `GET /v1/chains` for `"balances": true`.
4. Revoke the old key at the provider, and check that no process still uses it (the provider's usage graph for the old key drops to zero).

For a leaked key, revoke first: the other providers in the list carry the traffic while you rotate.

## Provider outage

- One provider down: nothing to do at once. Requests fail over; ranking moves the endpoint last within a minute. If it lasts, move it to the end of the variable or remove it, and roll.
- Every provider of a chain down: `/v1/chains` shows `"balances": false` for the chain and `/v1/balances` answers `503 rpc_unavailable`. The token picker shows no balances; swaps still work. Add a third provider from the list of vetted ones, or wait.
- A provider returning wrong data: the data checks catch a wrong chain or a stale or rewound block. A provider that lies consistently cannot be detected by one read. If users report wrong balances, compare the provider with another for the same address and block (`cast balance <address> --block <n> --rpc-url <url>`), remove the bad one and roll. Balances are display data only (ADR 0009): fees, route vetting and signing never use them.

## Rate limits

The API bounds its own concurrency: identical requests are merged, a wallet's balances are reused for 3 s, at most 8 reads run per chain and 32 wait; beyond that clients get `503 rpc_unavailable` at once. That does not bound cost: a client cycling through addresses bypasses the cache and can spend about 55 RPC requests per second per chain (roughly 14 million a day across three chains) while keeping the limiter full for everyone else. Per-client-IP limits and a global ceiling for `POST /v1/balances`, sized to the RPC plan, are a release gate ([edge-rate-limiting.md](edge-rate-limiting.md)). Set provider-side spending caps or alerts as a backstop.

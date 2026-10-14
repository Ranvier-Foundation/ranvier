# ADR 0006: Token and chain lists

- Status: accepted
- Date: 2026-10-12

## Context

The web app needs a token picker and a swap screen that runs in the browser. The API must therefore:

- tell the browser which chains it serves;
- offer a searchable list of tokens per chain;
- allow the web app's origin to call it cross-origin.

Two kinds of harm follow from a token list:

- **Phishing.** A wrong address in a list (a look-alike or fake token) sends users to a scam token under a trusted name.
- **Wrong money maths.** Token decimals are trusted input. They set the USD value of a swap, so the fee tier and the first-swap waiver, and they feed the oracle bound in route vetting (ADR 0004). The oracle's decimals are cross-checked against `knownDecimals` in `@ranvier/chains`, but until now that covered only stablecoins and wrapped natives.

## Decision

### A curated, static list, checked in

- `TOKEN_LIST` in `packages/chains/src/tokens.ts` holds the native coin and a short list of established tokens for each chain the API quotes today: Ethereum, Base and Arbitrum One. Solana is not listed yet; the types (`TokenInfo` in `@ranvier/types`) already cover it.
- The list is code, read at build time. It is not fetched from a remote token list at runtime. A fetched list would make its host, and every network hop to it, a trusted input that could swap an address or a decimals value without review.
- Every entry is sourced from the issuer's documentation or a well-known curated list (Uniswap default list, CoinGecko list), and is then verified on its own against DefiLlama metadata and an on-chain `symbol()`/`decimals()` read. A token that cannot be verified from two sources is left out. The runbook records each token's sources, verification date and risk record in the repository.
- DefiLlama is evidence of identity and price only. Its confidence says nothing about depth on a given chain (it returns one price and timestamp for cbBTC on all three chains, and one shared price for Base and Arbitrum DAI). Depth is recorded separately in the runbook as on-chain total supply. A thin token (Arbitrum cbBTC, Base DAI) may stay listed; it routes only if a provider quotes it, and the quote still passes route vetting.
- `pnpm --filter @ranvier/chains verify:tokens` re-checks every entry on demand: on-chain `symbol()`, `name()` and `decimals()`, DefiLlama symbol, decimals and confidence, and the L1 link of bridged tokens. Before reading a chain it checks that the RPC's `eth_chainId` is that chain, and fails every token of the chain otherwise (cbBTC has one address on three chains, so a mis-pointed RPC would pass it). It exits non-zero on any mismatch or failed read. RPC URLs are validated before use and never printed; URL-looking text in errors is replaced. It needs the network, so it is not part of CI; the runbook makes it a required step for every list change and every release.
- A `bridged` token must carry a checkable `bridge` link or a written `bridgeExemption` (a reason and a gateway whose `wards()` entry `verify:tokens` checks is 1); a test enforces it. Arbitrum DAI is the one exemption: Maker's Dai gateway has no `l1Address()`. Neither field is served to clients.
- `TOKEN_LIST`, the chain registry `CHAINS` (including `stablecoins` and `knownDecimals`) and `FEE_SCHEDULE` are deep-frozen at runtime with one shared `deepFreeze`, because they are trusted fee and decimals data: no in-process code can, for example, add WETH to a chain's stablecoin allowlist.
- Tokens the fee wrapper cannot handle are left out: rebasing and fee-on-transfer tokens, which the wrapper refuses on-chain (`UnsupportedToken`).
- **Issuer and governance powers need a recorded decision.** Any power held by a party that is not immutable code (upgrading the contract, pausing transfers, blacklisting holders, minting without a bound) must be named in the runbook's risk table, with the decision that accepted it. Most listed tokens have at least one such power: USDC, USDT, USDT0 and cbBTC are issuer-controlled (upgrade, pause, blacklist); AAVE, ARB and Arbitrum WETH are upgradeable by governance; Arbitrum's bridged tokens are beacon proxies of the bridge; WBTC on Ethereum can be paused by its owner; LINK on Base is minted by an owner-managed CCIP minter set. We accept these for established assets because a swap aggregator without them is not useful, and it is the trust model every holder of these assets already accepts. A token whose powers are unknown is not listed.
- **Display and fees cannot drift.** The 0.05% stablecoin fee uses the registry's `stablecoins` allowlist (spec section 2, ADR 0002). A test requires that, on every chain with a list, the tokens tagged `stablecoin` are exactly that allowlist, keyed by symbol. Following spec section 2 ("USDC, USDT, DAI, etc."), the owner extended the allowlist to DAI on Base and Arbitrum and USDT0 on Arbitrum. The fee rules themselves did not change. A pair of stablecoins on two different chains also pays 5 bps, because each token is checked on its own chain; a fee test pins this.

### Decimals have one source

- For each chain with a list, the registry's `knownDecimals` is derived from the list (`listedDecimals(chain)`). There is no second table to drift out of step.
- So the oracle cross-check in ADR 0004 now covers every listed token. If DefiLlama reports other decimals for a listed token, the price is refused and no quote is offered.
- Tests require:
  - lowercase EVM addresses that are unique per chain;
  - unique symbols per chain;
  - one `native` entry that matches the registry;
  - every registry stablecoin and wrapped native present in the list with the right tag;
  - `knownDecimals` equal to the list.
- Tokens that are not listed still trade, with decimals from DefiLlama alone, exactly as ADR 0004 describes. The list curates what the picker shows; it is not an allowlist for quotes.

### Endpoints

Both answer from checked-in data only. No provider, oracle or signer is called, and no request value is echoed back.

- `GET /v1/chains` returns the registry chains in `ZEROX_CHAIN_IDS`, in registry order: `key`, `name`, `family`, `nativeSymbol`, `nativeDecimals`, `explorer`, and `quoting`. `quoting` is true when routing is configured and the chain has trusted routers. ADR 0009 adds `balances` (true when `POST /v1/balances` can read the chain right now); that one flag comes from RPC health, not checked-in data. Registry internals (oracle names, allowlists) are not sent.
- `GET /v1/tokens?chain=&q=&limit=` validates its query with a strict schema:
  - `chain` must be a registry chain. A registry chain with no list returns `[]`.
  - `q` is at most 64 characters of letters, digits, currency signs, spaces, `.`, `_` and `-`.
  - `limit` is a decimal integer from 1 to 100, default 50.
  - Unknown or repeated parameters are refused with `400 invalid_request` and field paths only.

  Search rules:
  - A full EVM address matches that address exactly, in any case. Partial addresses match nothing.
  - Other text matches symbols by case-insensitive substring, and names as well from two characters.

  Order: the native coin, then stablecoins, then the rest, each group by symbol.

- Both responses have `Cache-Control: private, max-age=300`: the browser may keep them for five minutes, shared caches may not. Error responses have no cache header. If a shared cache or CDN is ever put in front of the API, it must key on `Origin` (responses carry per-origin CORS headers and `Vary: Origin`) or bypass caching for `/v1/*`.

### CORS

- A minimal handler in `apps/api/src/http/cors.ts`, rather than a plugin, so every header we grant is visible in one place and no dependency is added.
- `WEB_ORIGINS` holds comma-separated exact origins. Entries are trimmed. Startup refuses any of these:
  - a path or trailing slash;
  - upper case or a default port;
  - credentials;
  - a wildcard or `null`;
  - a scheme other than http or https;
  - an empty entry or a duplicate;
  - plain `http:` unless the host is loopback (`localhost`, `127.0.0.1`, `[::1]`), whenever `NODE_ENV=production` **or** any chain in `ZEROX_CHAIN_IDS` is not a known testnet or local chain. This is the same trigger as the KMS pin (`mainnetRulesApply` in `apps/api/src/mainnet-rules.ts`, used by `kmsPinRequired`), so a mainnet deployment that forgot `NODE_ENV` still refuses plain-http origins. The default `ZEROX_CHAIN_IDS` is mainnets.

  Unset means no cross-origin access, and no CORS code is registered.

- An allowed origin gets `Access-Control-Allow-Origin: <that origin>`, never `*`. `Access-Control-Allow-Credentials` and exposed headers are never sent.
- A preflight answers 204. If the origin is allowed and the requested method is GET or POST, it grants `GET, POST, OPTIONS` and the `content-type` header, cached for 600 seconds. Every other preflight gets no CORS headers.
- Unlisted origins get no CORS headers and are not an error. CORS is a browser rule, not access control; the API stays public.
- With CORS configured, every response carries `Vary: Origin`, so a shared cache never serves one origin's grant to another.

### Web CSP

`apps/web/next.config.ts` adds the origin of `NEXT_PUBLIC_API_URL` to `connect-src`. The value is read at **build** time: Next bakes the headers into the build, so changing it needs a rebuild. Only the origin is used. The value must be an http(s) URL with a plain DNS or IP host and no credentials, so it cannot inject a directive; a production build also refuses plain `http:` unless the host is loopback. Otherwise the build fails. When it is unset, `connect-src` stays `'self'`. No other header changes.

## Adding or removing a token

See [docs/runbooks/token-list.md](../runbooks/token-list.md). Every change is a reviewed PR that goes to the security reviewer, because it changes trusted decimals. Emergency delisting is a one-line removal and a normal deploy.

## Consequences and residual risks

- **A listed token can turn bad later.** Its issuer can pause, blacklist or upgrade it, it can be exploited, or (USDT) its dormant transfer-fee switch can be turned on. The list does not watch for this. The wrapper still refuses a fee-on-transfer swap on-chain, and the delisting runbook covers removal. However, between the event and a deploy, the picker still shows the token.
- **Bridged tokens** (DAI, UNI, LINK, WBTC and WETH on Arbitrum; DAI and UNI on Base) depend on their canonical bridges, and the Arbitrum ones are upgradeable by the bridge's governance.
- **List updates are manual.** A new chain or token needs a PR, and stale entries remain until someone removes them. This costs coverage, not safety.
- **No logos yet.** `logoUri` is optional and unset. When logos are added they must be served from our own origin or an allowlisted image host, and `img-src` in the CSP must be widened deliberately.
- **No token risk scanner.** A v1 token risk scanner is a later feature: it would cover honeypots, owner privileges and liquidity, and would warn on unlisted tokens.
- **Only quoted chains are served.** `GET /v1/chains` lists only registry chains in `ZEROX_CHAIN_IDS`, so a testnet in that list that the registry does not know is not shown.

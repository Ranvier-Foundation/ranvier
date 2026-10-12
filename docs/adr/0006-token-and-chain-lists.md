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
- Every entry is sourced from the issuer's documentation or a well-known curated list (Uniswap default list, CoinGecko list), and is then verified on its own against DefiLlama metadata and an on-chain `symbol()`/`decimals()` read. A token that cannot be verified from two sources is left out. The PR that adds a token records its sources and the date.
- Tokens the fee wrapper cannot handle are left out: rebasing and fee-on-transfer tokens, which the wrapper refuses on-chain (`UnsupportedToken`). So are tokens whose issuer can freeze or pause transfers behind an upgradeable proxy, with one exception: the core stablecoins USDC and USDT (USDT0 on Arbitrum). Their issuers can upgrade, pause and blacklist them. We accept that, because a swap aggregator without them is not useful, and it is the trust model every user of these coins already accepts.
- The `stablecoin` tag in the list is for display and ordering only. The 0.05% stablecoin fee still uses only the registry's `stablecoins` allowlist (spec section 2, ADR 0002). This ADR does not change the fee schedule.

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

- `GET /v1/chains` returns the registry chains in `ZEROX_CHAIN_IDS`, in registry order: `key`, `name`, `family`, `nativeSymbol`, `nativeDecimals`, `explorer`, and `quoting`. `quoting` is true when routing is configured and the chain has trusted routers. Registry internals (oracle names, allowlists) are not sent.
- `GET /v1/tokens?chain=&q=&limit=` validates its query with a strict schema:
  - `chain` must be a registry chain. A registry chain with no list returns `[]`.
  - `q` is at most 64 characters of letters, digits, currency signs, spaces, `.`, `_` and `-`.
  - `limit` is a decimal integer from 1 to 100, default 50.
  - Unknown or repeated parameters are refused with `400 invalid_request` and field paths only.

  Search rules:
  - A full EVM address matches that address exactly, in any case. Partial addresses match nothing.
  - Other text matches symbols by case-insensitive substring, and names as well from two characters.

  Order: the native coin, then stablecoins, then the rest, each group by symbol.

- Both responses have `Cache-Control: public, max-age=300`. Error responses have no cache header.

### CORS

- A minimal handler in `apps/api/src/http/cors.ts`, rather than a plugin, so every header we grant is visible in one place and no dependency is added.
- `WEB_ORIGINS` holds comma-separated exact origins. Entries are trimmed. Startup refuses any of these:
  - a path or trailing slash;
  - upper case or a default port;
  - credentials;
  - a wildcard or `null`;
  - a scheme other than http or https;
  - an empty entry or a duplicate.

  Unset means no cross-origin access, and no CORS code is registered.

- An allowed origin gets `Access-Control-Allow-Origin: <that origin>`, never `*`. `Access-Control-Allow-Credentials` and exposed headers are never sent.
- A preflight answers 204. If the origin is allowed and the requested method is GET or POST, it grants `GET, POST, OPTIONS` and the `content-type` header, cached for 600 seconds. Every other preflight gets no CORS headers.
- Unlisted origins get no CORS headers and are not an error. CORS is a browser rule, not access control; the API stays public.
- With CORS configured, every response carries `Vary: Origin`, so a shared cache never serves one origin's grant to another.

### Web CSP

`apps/web/next.config.ts` adds the origin of `NEXT_PUBLIC_API_URL` to `connect-src`, read at build or start. Only the origin is used. The value must be an http(s) URL with a plain DNS or IP host and no credentials, so it cannot inject a directive; otherwise the build fails. When it is unset, `connect-src` stays `'self'`. No other header changes.

## Adding or removing a token

See [docs/runbooks/token-list.md](../runbooks/token-list.md). Every change is a reviewed PR that goes to the security reviewer, because it changes trusted decimals. Emergency delisting is a one-line removal and a normal deploy.

## Consequences and residual risks

- **A listed token can turn bad later.** Its issuer can pause, blacklist or upgrade it, it can be exploited, or (USDT) its dormant transfer-fee switch can be turned on. The list does not watch for this. The wrapper still refuses a fee-on-transfer swap on-chain, and the delisting runbook covers removal. However, between the event and a deploy, the picker still shows the token.
- **Bridged tokens** (L2 DAI, UNI, LINK, WBTC on Arbitrum; DAI and UNI on Base) depend on their canonical bridges, and the Arbitrum ones are upgradeable by the bridge's governance.
- **List updates are manual.** A new chain or token needs a PR, and stale entries remain until someone removes them. This costs coverage, not safety.
- **No logos yet.** `logoUri` is optional and unset. When logos are added they must be served from our own origin or an allowlisted image host, and `img-src` in the CSP must be widened deliberately.
- **No token risk scanner.** A v1 token risk scanner is a later feature: it would cover honeypots, owner privileges and liquidity, and would warn on unlisted tokens.
- **Only quoted chains are served.** `GET /v1/chains` lists only registry chains in `ZEROX_CHAIN_IDS`, so a testnet in that list that the registry does not know is not shown.

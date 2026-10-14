# ADR 0010: Token picker data (web)

- Status: accepted
- Date: 2026-10-14

## Context

The Select token screen needs the chains and tokens the API serves (ADR 0006) and the connected wallet's balances (ADR 0009). Three things shape how the browser may use them:

- **The browser is a hostile place to render strings.** Token names, symbols and chain names come over the network. The strict CSP (ADR 0008) stops injected scripts, but injected text can still mislead (look-alike names, direction overrides) and an API string used as a `href`, `src` or markup would be a way out of the policy's assumptions.
- **Balances are personal data and display data.** The wallet address reaches the API (and, through it, an RPC provider). A balance must never decide anything that matters (ADR 0009).
- **Late answers.** A user switches chain or types faster than the network answers.

## Decision

- **Only our API.** The picker calls `GET /v1/chains`, `GET /v1/tokens` and `POST /v1/balances` at the origin baked into the build (`RANVIER_BUILD_API_ORIGIN`, the same value that went into `connect-src`). It never talks to an RPC provider. An e2e fixture fails any test whose page requests an origin other than the app and the API.
- **Request hygiene** (`apps/web/src/lib/api/client.ts`): `credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, `Accept: application/json`; a timeout on every request; the answer must be `200` and `application/json`, is read with a size cap, and is valid UTF-8. `POST /v1/balances` is `cache: 'no-store'`, and the wallet address is in the body only, never in a URL. Errors carry fixed text (a kind and a status), never a URL, body or address.
- **Validated, typed schemas, refused whole** (`lib/api/schemas.ts`, no schema library, no new dependency). Every response is parsed from `unknown`: exact key types, chain keys and addresses by pattern (lowercase 20-byte hex or `native`), decimals 0 to 36, balances as decimal strings up to uint256 turned into `bigint`, lengths bounded, duplicates refused. Tokens must belong to the chain asked for; balances must name the chain and wallet asked for. Anything that does not match is an error state, never repaired or partly shown. Unknown tags are ignored (they only label and order rows). `logoUri` is checked as a string and then dropped: no image is loaded from an API string (ADR 0006: logos need their own CSP decision).
- **Text only.** Text is rejected if it contains control, format (bidirectional overrides and isolates, zero-width marks) or line-separator characters, or is padded. It is rendered as React text. API strings are never used as `href`, `src`, `next/script`, `ReactDOM.preinit` or `dangerouslySetInnerHTML` (the last is banned by ESLint). Markup in a name shows as literal text (an e2e test).
- **Money maths.** Balances are `bigint` base units and decimals come from `/v1/tokens`; one formatter (`formatTokenAmount`) truncates, never rounds up, and never uses a float. No USD value is shown: the API sends no prices to the picker.
- **Balances are display only.** A failed read, an unavailable chain (`balances: false`) or no wallet shows a note in the footer band and the token list stays complete and selectable. Selecting returns `{ chain, address }` only (spec section 14).
- **Stale answers.** Every request has an `AbortController`. Switching chain aborts the requests of chains that left the screen; a new search text (after a 200 ms pause) aborts the previous search; closing the picker aborts everything. A completion handler drops its answer if its request was aborted, so rows never belong to a chain or search the user has left. Search text the API would refuse (characters outside its set, over 64 characters) is not sent: the picker shows "no match".
- **Wallet address.** Read from the connection (wagmi) and sent only to our API for balances. The picker asks the wallet for nothing (an e2e test checks the wallet's method log).

## Consequences and residual risks

- A compromised or buggy API can still show wrong names or balances that pass the schema (look-alike letters, for instance). The list is curated and checked in (ADR 0006); display text is not a signing input, and the review screen must show amounts from the wallet and a simulation (ADR 0009).
- The API origin is baked at build time: a build without `NEXT_PUBLIC_API_URL` shows "The token list is not available on this site yet" and makes no request.
- Stale-answer handling is per request, not a shared cache: re-opening the picker asks again (the browser's HTTP cache keeps `/v1/chains` and `/v1/tokens` for five minutes as the API allows).
- The wallet address is sent to the API when the picker opens. Edge rate limits for `/v1/balances` are a release gate (ADR 0009).

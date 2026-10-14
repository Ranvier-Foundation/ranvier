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
- **Look-alike text** (`tokenSymbol`, `tokenName` in `lib/api/schemas.ts`; the whole response is refused on a miss):
  - A token **symbol** is ASCII: `^[A-Za-z0-9.+-]{1,32}$`. No other script, fullwidth or mathematical letters, spaces (including no-break), blank-rendering or combining characters.
  - A token **name** (after the text rules above) may hold only letters (`\p{L}`), currency signs (`\p{Sc}`, for `USD₮0`) and printable ASCII. It must not hold a double space, a Unicode `Default_Ignorable_Code_Point` (Hangul fillers U+115F, U+1160, U+3164, U+FFA0 and the like), and must be stable under NFKC (no fullwidth forms, mathematical alphanumerics or ligatures). That already leaves out combining marks, U+2800, non-ASCII spaces and digits, and emoji. All letters must come from one writing system: Latin (Basic Latin, Latin-1 Supplement and Latin Extended-A only), Greek, Cyrillic, Hebrew, Arabic, Hangul, or Japanese (Han, Hiragana and Katakana together); any other script is refused.
  - **One symbol per chain** (compared without case) in an answer, or the answer is refused.
  - The checked-in list (`TOKEN_LIST` in `@ranvier/chains`) must pass these rules; a unit test checks every entry. A token that needs other characters is a deliberate change to the rule and its tests.
  - **Same symbol, several chains.** When two or more rows on screen share a symbol, each shows a short address (`0x1234…abcd`) after the chain name, as text, never a link (a native coin has none). It is in the row's accessible name too. The wallet user can then tell a token from a look-alike listed on another chain.
- **Money maths.** Balances are `bigint` base units and decimals come from `/v1/tokens`; one formatter (`formatTokenAmount`) truncates, never rounds up, and never uses a float. No USD value is shown: the API sends no prices to the picker.
- **Balances are display only.** A failed read, an unavailable chain (`balances: false`) or no wallet shows a note in the footer band and the token list stays complete and selectable. Selecting returns `{ chain, address }` only (spec section 14).
- **Stale answers.** Every request has an `AbortController`. Switching chain aborts the requests of chains that left the screen; a new search text (after a 200 ms pause) aborts the previous search; closing the picker aborts everything. A completion handler drops its answer if its request was aborted, so rows never belong to a chain or search the user has left. Search text the API would refuse (characters outside its set, over 64 characters) is not sent: the picker shows "no match". Search text that contains the connected wallet's address (40 hex digits, any case, with or without `0x`) is not sent either, because search text goes into a URL (logged and cached more widely than a request body); the picker shows "no match".
- **Wallet address.** Read from the connection (wagmi) and sent only to our API for balances. The picker asks the wallet for nothing (an e2e test checks the wallet's method log).

## Consequences and residual risks

- A compromised or buggy API can still show wrong names or balances that pass the schema. The look-alike rules above close the common tricks (other scripts mixed into a word, fullwidth and mathematical letters, blank and stacked characters, a duplicate symbol on a chain) but not all: a name written wholly in one script (all-Cyrillic or all-Greek) can resemble another word, and Latin letters such as a dotless i stay allowed. The short address on a shared symbol, and the curated list, are the other defences. Search text is sent after a 200 ms pause, so someone typing their own address slowly may send a prefix of it. The list is curated and checked in (ADR 0006); display text is not a signing input, and the review screen must show amounts from the wallet and a simulation (ADR 0009).
- The API origin is baked at build time: a build without `NEXT_PUBLIC_API_URL` shows "The token list is not available on this site yet" and makes no request.
- Stale-answer handling is per request, not a shared cache: re-opening the picker asks again (the browser's HTTP cache keeps `/v1/chains` and `/v1/tokens` for five minutes as the API allows).
- The wallet address is sent to the API when the picker opens. Edge rate limits for `/v1/balances` are a release gate (ADR 0009).

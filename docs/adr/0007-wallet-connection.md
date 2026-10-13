# ADR 0007: Wallet connection (web)

- Status: accepted
- Date: 2026-10-13

## Context

The swap screen needs to let a person connect an EVM wallet, show who is connected, switch network and disconnect. This change does not read balances, quote, sign or send anything. Those come next and will build on the connection layer chosen here.

Two things shape the choice:

- **The page is the trust boundary.** Anything a wallet announces to the page (its name, icon, identifiers) is data that any script on the page can forge. Connecting is the one step where a user hands a site their address.
- **The web app has a strict CSP** (ADR-less, in `apps/web/next.config.ts`): `connect-src` allows the API origin only. Every extra origin a wallet SDK needs is a place data can leave.

## Decision

### wagmi, viem and EIP-6963 discovery

- `wagmi` 3.7.7, `viem` 2.56.9 and `@tanstack/react-query` 5.103.3 (wagmi's peer), all pinned exactly. wagmi was chosen because the spec stack names it and it handles the awkward parts (reconnect on load, chain and account change events, error normalisation) that we would otherwise write and get subtly wrong.
- Wallets are found through **EIP-6963** (wagmi's built-in discovery, via `mipd`): each browser wallet announces itself with a name, icon and reverse-DNS id, and the dialog lists what was announced. No wallet brand logos or names are in our code. No connector is configured by hand, and the optional heavy connectors in `@wagmi/connectors` (Coinbase, MetaMask SDK, Safe, WalletConnect, Base Account) are not installed.
- New transitive packages: `@wagmi/core`, `@wagmi/connectors` (no runtime dependencies of its own; every SDK it can use is an optional peer and not installed), `@tanstack/query-core`, `mipd`, `zustand` and `use-sync-external-store`. None has an install script, and `allowBuilds` still lists only `esbuild`.
- Dependency ages on 2026-10-13: wagmi, `@wagmi/core` and `@wagmi/connectors` 47 days; react-query and query-core 17 days; `viem` 2.56.9 (published 2026-09-24) 19 days and its `ox` 0.14.45 (2026-09-17) 26 days; `mipd`, `zustand` and `use-sync-external-store` over a year. No new package is younger than 14 days. `viem` is deliberately one patch behind `apps/api` (2.57.4, 5 days old, `ox` 0.14.54), which will move down to 2.56.9 in a separate chore so the two match again.

### WalletConnect is not included

`@walletconnect/ethereum-provider` depends on `@reown/appkit` (the full modal SDK this project does not want) and on a large tree of further packages, and it needs relay, RPC and verify origins in the CSP. That cost buys phone-wallet QR connection, which is not needed for the first connected screen. The dialog shows a disabled "Phone wallet, coming soon" row, and `NEXT_PUBLIC_REOWN_PROJECT_ID` is not read. When it is added it will be loaded lazily, only when the id is set at build, with the exact origins it needs added to the CSP (no wildcards) and tests for the builder.

### No RPC from the browser

The wagmi config has one transport per chain and every transport refuses requests. The wallet itself answers connection and chain queries. This means the CSP gains no RPC origin and no WebSocket origin. The consequence of wagmi's switch-chain fallback: if a wallet does not know a chain (error 4902), wagmi asks it to add the chain with an empty RPC URL, which wallets refuse. We show "Your wallet could not switch to {chain}. Add the network in your wallet, then try again." (not "declined", see `classifyWalletError`). Registry chains carry no RPC URL by design (`@ranvier/chains`: RPC URLs are environment config).

### CSP

Unchanged. `img-src 'self' data:` already allows the `data:` icons wallets announce; it is not widened. A test pins that the policy has no `wss:`, WalletConnect, Reown or wildcard origin.

### What is stored in the browser

wagmi's default storage, `localStorage`, keys prefixed `wagmi.`: `wagmi.store` (the connection preference: connector id, name and uid, the connected account addresses and chain id), `wagmi.recentConnectorId`, and `<wallet>.disconnected` flags so that a deliberate disconnect survives a reload. Nothing else; no key material, no signatures. Addresses are stored because wagmi needs them to restore the connection; they stay in the person's own browser and are never sent anywhere or logged. `ssr: true` keeps the server render and the first client render identical (signed out); the saved connection is restored after hydration, so no address is in server-rendered HTML.

### Trust model for provider-supplied values

Wallet name, rdns, uuid and icon are untrusted (`apps/web/src/lib/wallet/wallets.ts`). They come from a page script and may be any JavaScript value, not only strings (objects with a `toString` that changes between calls, getters, Proxies):

- Each field is read once, must be a primitive `string` (checked with `typeof`) before any other use, and only that checked primitive is used afterwards. Nothing calls a method on a provider-supplied object. Anything that is not a string drops the field (icon) or the wallet (id, name, uid, type).
- Only connectors of type `injected` whose id is a valid reverse-DNS name are listed. **The cap of 8 is applied in announcement order, before sorting**: the first 8 valid, deduplicated wallets are kept and the list is then sorted by name for display. A script that announces many wallets after the real ones therefore cannot push them out (sorting first and cutting after would let it). The cost: if more than 8 genuinely different wallets are installed, the ones announced later are not shown, and the dialog does not say so (a "more wallets not shown" note needs the sanitiser to return a count and a new string and is left for when it matters).
- **First announcement wins, and that is a limit, not a defence.** A real extension injects at document start, so it announces before page scripts and normally holds its rdns. mipd keeps the first announcement per announcement uuid, and wagmi skips a provider whose rdns is already taken (we also ignore a repeated rdns, case-insensitively). A script that announces first can take any rdns, for example an impostor under `io.metamask`; and a second wallet called "MetaMask" under another rdns is a different wallet as far as the protocol is concerned. We do not claim that announcing first or flooding gives no advantage. The mitigation is display: when the name skeletons of two listed wallets collide, each of those rows shows its rdns as text under the name. The skeleton is the cleaned name in NFKC, lower case, with everything but letters and digits removed, so "MetaMask", "Meta Mask", "METAMASK." and full-width forms collide. Invisible and blank-looking characters are removed from names first (everything Unicode marks default-ignorable, format and private-use characters, the Braille blank U+2800, leftover conjoining Hangul jamo), so a twin padded with them still collides. Homoglyphs from other scripts (a Cyrillic "a") are NOT folded and remain a documented limit. (wagmi gives every connector its own `uid`, so our uid check is only a second line behind the rdns check.) The user's wallet extension still asks them to approve the site, and the dialog never requests a signature.
- Names are NFKC-normalised, control characters and line or paragraph separators become spaces, format characters (zero-width, bidirectional controls, soft hyphen, word joiner), Hangul fillers, variation selectors and tag characters are removed, whitespace is collapsed and the name is cut to 40 characters. Combining marks that follow nothing (start of the name or a space) are dropped and runs longer than 3 are cut, so zalgo text cannot form. The name is then cut to 40 characters and only the final text is checked: without a letter or digit (for example only U+3164, or 45 combining marks before a letter) the wallet is dropped. Names are rendered as text by React, never as HTML.
- Icons must match `data:image/(png|svg+xml|webp);base64,<base64>` and be at most 64 KiB of text. They are only ever the `src` of an `<img>` (which does not run scripts in SVG), never inline SVG and never `dangerouslySetInnerHTML`. Anything else shows the wallet's first letter.
- Error text from a wallet is never shown. Only the error kind is read (user rejected, request pending, other) and our own message is displayed.
- The unit tests cover objects with changing `toString`, `valueOf` and `Symbol.toPrimitive`, getters that change between reads, and Proxies; an end-to-end test announces such wallets and asserts that every `<img>` is a `data:` image and no request leaves the origin.

What the tests enforce about requests to the wallet: for every end-to-end test, every JSON-RPC method the page sent to the fake wallet (recorded across reloads) must be one of `eth_accounts`, `eth_chainId`, `eth_requestAccounts`, `wallet_requestPermissions`, `wallet_revokePermissions`, `wallet_switchEthereumChain` or `wallet_addEthereumChain`. This is an allowlist. The fake wallets also expose the legacy `send`, `sendAsync` and `enable`; any call to them is recorded with a `legacy:` prefix and so always fails the check. The log is kept on the test side and read after a short settle, so the last call is not missed, and a negative test proves that signing and legacy calls are caught. It checks our code against a fake wallet; it does not stop another script in the page from calling a real wallet.

### Wallet avatar

Four quadrants, each one of `primary`, `blush`, `accent` or `deep-tile`, chosen by folding the 20 address bytes into four accumulators. Only token names leave the function; a flat single-colour disc is avoided. See `docs/ui-guidelines.md`.

### Residual risks

- **`script-src 'unsafe-inline'` remains in the CSP** (pre-existing; Next inlines its bootstrap scripts). Wallet code now lives in the app, so a script injection can reach wallet requests. The fix is a strict CSP with per-request nonces, `'strict-dynamic'` and SRI (spec section 9). It is not part of this change and **must land before any signing or transaction flow**.
- **An announcement flood slows the tab (availability only).** mipd's store is unbounded, and wagmi runs its setup for every stored provider on every announcement, which is quadratic: the security review measured 800 announcements at about 3.7 s of main-thread time. Exploiting it needs a hostile script or extension already running in the page, and gains nothing but a slow page. Accepted. Bounding it would mean `multiInjectedProviderDiscovery: false` plus our own capped EIP-6963 listener feeding `injected({ target })`. wagmi has no public API to add a connector after `createConfig`, so that needs wagmi's internal connector store (or re-creating the config on every announcement), which ties us to wagmi internals and needs its own tests; it is not a small change and was left out.
- **A malicious announcer can take any rdns first** (see the trust model). Mitigated by showing the rdns when names collide, not prevented.
- Homoglyph names that neither NFKC nor the name skeleton fold (a Cyrillic "a" for a Latin one) are not detected as look-alikes.

### Out of scope

Solana wallets, passkey accounts, WalletConnect, balances, token picker, quotes, any signing or transactions, ENS names and avatars, the "other wallets" count across families (the `+N` shows other authorised EVM accounts only).

## Consequences

- Adding a wallet SDK later is a deliberate change with its own CSP and review, not something that arrives through a transitive dependency.
- A wallet that does not announce through EIP-6963 (very old extensions) is not listed. Modern wallets all announce.
- `wagmi.store` holds addresses in the browser's localStorage. Anyone with access to the browser profile can already read them from the wallet extension.

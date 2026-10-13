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

- `wagmi` 3.7.7, `viem` 2.57.4 (the version `apps/api` already pins) and `@tanstack/react-query` 5.103.3 (wagmi's peer), all pinned exactly. wagmi was chosen because the spec stack names it and it handles the awkward parts (reconnect on load, chain and account change events, error normalisation) that we would otherwise write and get subtly wrong.
- Wallets are found through **EIP-6963** (wagmi's built-in discovery, via `mipd`): each browser wallet announces itself with a name, icon and reverse-DNS id, and the dialog lists what was announced. No wallet brand logos or names are in our code. No connector is configured by hand, and the optional heavy connectors in `@wagmi/connectors` (Coinbase, MetaMask SDK, Safe, WalletConnect, Base Account) are not installed.
- New transitive packages: `@wagmi/core`, `@wagmi/connectors` (no runtime dependencies of its own; every SDK it can use is an optional peer and not installed), `@tanstack/query-core`, `mipd`, `zustand` and `use-sync-external-store`. None has an install script, and `allowBuilds` still lists only `esbuild`.
- Dependency ages at the time of this change: wagmi, `@wagmi/core` and `@wagmi/connectors` 47 days; react-query and query-core 17 days; `viem` 2.57.4 is 5 days old because it is the version `apps/api` already runs and the two must stay one version (owner decision).

### WalletConnect is not included

`@walletconnect/ethereum-provider` depends on `@reown/appkit` (the full modal SDK this project does not want) and on a large tree of further packages, and it needs relay, RPC and verify origins in the CSP. That cost buys phone-wallet QR connection, which is not needed for the first connected screen. The dialog shows a disabled "Phone wallet, coming soon" row, and `NEXT_PUBLIC_REOWN_PROJECT_ID` is not read. When it is added it will be loaded lazily, only when the id is set at build, with the exact origins it needs added to the CSP (no wildcards) and tests for the builder.

### No RPC from the browser

The wagmi config has one transport per chain and every transport refuses requests. The wallet itself answers connection and chain queries. This means the CSP gains no RPC origin and no WebSocket origin. The consequence of wagmi's switch-chain fallback: if a wallet does not know a chain (error 4902), wagmi asks it to add the chain with an empty RPC URL, which wallets refuse. We show "Your wallet could not switch to {chain}. Add the network in your wallet, then try again." (not "declined", see `classifyWalletError`). Registry chains carry no RPC URL by design (`@ranvier/chains`: RPC URLs are environment config).

### CSP

Unchanged. `img-src 'self' data:` already allows the `data:` icons wallets announce; it is not widened. A test pins that the policy has no `wss:`, WalletConnect, Reown or wildcard origin.

### What is stored in the browser

wagmi's default storage, `localStorage`, keys prefixed `wagmi.`: `wagmi.store` (the connection preference: connector id, name and uid, the connected account addresses and chain id), `wagmi.recentConnectorId`, and `<wallet>.disconnected` flags so that a deliberate disconnect survives a reload. Nothing else; no key material, no signatures. Addresses are stored because wagmi needs them to restore the connection; they stay in the person's own browser and are never sent anywhere or logged. `ssr: true` keeps the server render and the first client render identical (signed out); the saved connection is restored after hydration, so no address is in server-rendered HTML.

### Trust model for provider-supplied strings

Wallet name, rdns, uuid and icon are untrusted (`apps/web/src/lib/wallet/wallets.ts`):

- Only connectors of type `injected` whose id is a valid reverse-DNS name are listed; the rest are ignored. Duplicates (same rdns, case-insensitive, or same uid) are dropped, the list is capped at 8 and sorted by name, so announcing first or flooding gives no advantage.
- Names lose control, zero-width and bidirectional-override characters, are whitespace-collapsed and cut to 40 characters. They are rendered as text by React, never as HTML.
- Icons must match `data:image/(png|svg+xml|webp);base64,<base64>` and be at most 64 KiB of text. They are only ever the `src` of an `<img>` (which does not run scripts in SVG), never inline SVG and never `dangerouslySetInnerHTML`. Anything else shows the wallet's first letter.
- Error text from a wallet is never shown. Only the error kind is read (user rejected, request pending, other) and our own message is displayed.
- A page script can announce a fake wallet. The dialog only lists wallets; connecting is a user action on a specific wallet, and the app never requests a signature or transaction in this change. The names shown are what the wallet claims, as in every EIP-6963 dapp; the user's own wallet extension asks them to approve the site.

### Wallet avatar

Four quadrants, each one of `primary`, `blush`, `accent` or `deep-tile`, chosen by folding the 20 address bytes into four accumulators. Only token names leave the function; a flat single-colour disc is avoided. See `docs/ui-guidelines.md`.

### Out of scope

Solana wallets, passkey accounts, WalletConnect, balances, token picker, quotes, any signing or transactions, ENS names and avatars, the "other wallets" count across families (the `+N` shows other authorised EVM accounts only).

## Consequences

- Adding a wallet SDK later is a deliberate change with its own CSP and review, not something that arrives through a transitive dependency.
- A wallet that does not announce through EIP-6963 (very old extensions) is not listed. Modern wallets all announce.
- `wagmi.store` holds addresses in the browser's localStorage. Anyone with access to the browser profile can already read them from the wallet extension.

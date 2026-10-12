# ADR 0003: Fee quote signing

- Status: accepted
- Date: 2026-10-12

## Context

The fee wrapper only accepts fees signed by the backend (spec section 4), so the fee cannot be bypassed by calling the contract directly. The API has to produce signatures the contract verifies, and the signing key must be protected.

## Decision

- The API signs an EIP-712 `SwapQuote` (domain `Ranvier FeeWrapper`, version `1`, chain ID, wrapper address) for the best route and returns the full `swap(quote, signature, routerCalldata)` transaction.
- The quote binds the user, tokens, gross input, exact fee amount, minimum output, router, router calldata hash, a random 256-bit nonce and a deadline (default 60 seconds).
- Random nonces need no storage; the contract rejects reuse per user.
- Signing sits behind a `QuoteSigner` port. `LocalKeySigner` (key from the environment) is for development, testnets and local forks only. It refuses to start when `NODE_ENV=production`, and it only signs for an explicit allowlist of testnet and local chain IDs; mainnets are never signable (ADR 0004). Production uses a KMS/HSM signer (to be built), with the key rotated through the admin multisig.
- Only routes that pass `vetRoute` are signed. That function checks the router calldata, the minimum output and the oracle bound (ADR 0004).
- Native wrap/unwrap on an EVM chain (native coin to that same chain's wrapped native token or back, as detected by `isWrapOrUnwrap` in `@ranvier/fees`) bypasses the fee wrapper and signing by design. The fee schedule makes it free (ADR 0002), so there is no fee to enforce, and 0x does not support it through a wrapper: it rejects a `recipient` for wrap/unwrap and otherwise returns a call to the WETH contract itself, which is outside the router allowlist. `POST /v1/quotes` therefore answers directly with a plain call to the registry's wrapped native contract (`deposit()` with the amount as value, or `withdraw(wad)`), a 1:1 output, the zero `wrap-unwrap` fee, and no provider, price oracle, wallet history or signature. The response carries this under `direct` instead of `best`/`quotes`/`swap`. Solana wSOL wrapping is not covered and keeps the normal route.
- Golden-value tests in both TypeScript (`apps/api/src/domain/swap-quote.test.ts`) and Solidity (`contracts/test/QuoteSigningCompat.t.sol`) assert the same digest and signature, so encoding drift on either side fails CI.

## Consequences

- Anyone holding the signing key can sign any fee up to the 0.3% cap, including zero. The key is therefore a security-critical secret: KMS in production, monitored, rotatable.
- Changing `SwapQuote` means changing both sides and regenerating the golden values.
- Tokens sent to the fee wrapper outside a swap cannot be recovered, by design. There is no rescue or sweep function.
  - The wrapper never holds funds between transactions.
  - `swap` measures balances before and after, and leaves any balance that predates the swap untouched, so stray tokens cannot be taken by a later swapper.
  - A rescue function would add a privileged path that moves tokens out of the contract users approve. That path would be the most valuable target for a compromised admin key, and auditors would have to reason about it on every call.
  - Native coin is refused outside a swap (`receive` reverts), so only forced transfers (e.g. `selfdestruct`) can strand ETH.
  - The web app must never ask users to send tokens to the wrapper directly.
- `feeCollector` is immutable and receives native-coin fees through a plain call. It must be a Safe (or other contract) that accepts ETH. A collector that reverts on receive makes every fee-paying native-input swap revert, and fixing it needs a versioned redeploy. Check it on a fork before every deployment.
- Rate limiting of `/v1/quotes` is an edge responsibility (reverse proxy or WAF), not built into the API. Every quote can make paid upstream calls (0x). See [docs/runbooks/edge-rate-limiting.md](../runbooks/edge-rate-limiting.md).

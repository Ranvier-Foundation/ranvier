# ADR 0003: Fee quote signing

- Status: accepted
- Date: 2026-10-12

## Context

The fee wrapper only accepts fees signed by the backend (spec section 4), so the fee cannot be bypassed by calling the contract directly. The API has to produce signatures the contract verifies, and the signing key must be protected.

## Decision

- The API signs an EIP-712 `SwapQuote` (domain `Ranvier FeeWrapper`, version `1`, chain ID, wrapper address) for the best route and returns the full `swap(quote, signature, routerCalldata)` transaction.
- The quote binds the user, tokens, gross input, exact fee amount, minimum output, router, router calldata hash, a random 256-bit nonce and a deadline (default 60 seconds).
- Random nonces need no storage; the contract rejects reuse per user.
- Signing sits behind a `QuoteSigner` port. `LocalKeySigner` (key from the environment) is for development and testnets only and refuses to start when `NODE_ENV=production`. Production uses a KMS/HSM signer (to be built), with the key rotated through the admin multisig.
- Golden-value tests in both TypeScript (`apps/api/src/domain/swap-quote.test.ts`) and Solidity (`contracts/test/QuoteSigningCompat.t.sol`) assert the same digest and signature, so encoding drift on either side fails CI.

## Consequences

- Anyone holding the signing key can sign any fee up to the 0.3% cap, including zero. The key is therefore a security-critical secret: KMS in production, monitored, rotatable.
- Changing `SwapQuote` means changing both sides and regenerating the golden values.

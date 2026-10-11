# ADR 0002: Fee schedule semantics

- Status: proposed (needs owner sign-off)
- Date: 2026-10-11

## Context

Section 2 of the spec sets the fee tiers and special cases but leaves some edge cases open.

## Decision

Rules are applied in this order; the first one that matches wins:

1. Native wrap/unwrap (e.g. ETH to WETH): 0 bps.
2. First swap for a new wallet with a USD value of $1,000 or less: 0 bps. A first swap above $1,000 pays the normal rate. **Open question:** the alternative reading is "the first $1,000 is free and the rest pays the normal rate".
3. Allowlisted stablecoin to allowlisted stablecoin: 5 bps.
4. Size tiers: under $10,000 pays 20 bps; $10,000 up to and including $100,000 pays 15 bps; above $100,000 pays 10 bps.

The fee is `floor(amountIn * bps / 10000)` in input-token base units. USD values are integer cents.

## Consequences

The backend computes the rate and signs it into the quote (EIP-712). The contract enforces a hard cap of 30 bps.

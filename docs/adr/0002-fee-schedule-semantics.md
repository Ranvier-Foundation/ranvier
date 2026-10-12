# ADR 0002: Fee schedule semantics

- Status: accepted
- Date: 2026-10-11

## Context

The fee schedule sets tiers and special cases. Some edge cases needed a decision, in particular how the first-swap promotion combines with the other rates.

## Decision

**Base rate.** Rules are checked in this order; the first one that matches sets the rate:

1. Native wrap/unwrap (e.g. ETH to WETH): 0 bps.
2. Allowlisted stablecoin to allowlisted stablecoin: 5 bps. (The allowlist is data: `stablecoins` per chain in `packages/chains/src/registry.ts`, kept equal to the token list's `stablecoin` tag by tests and deep-frozen at runtime; see ADR 0006.) A cross-chain pair of stablecoins also pays 5 bps, because each token is checked on its own chain's allowlist; a fee test pins this. That is a revenue choice: spec section 2 does not distinguish cross-chain pairs, and whether the owner intends 5 bps there is **owner to confirm**. Depeg risk is accepted: the fee is taken in the input token, so a depegged allowlisted stablecoin still pays 5 bps of its own (lower-valued) units.
3. Size tiers by the full swap's USD value: under $10,000 pays 20 bps; $10,000 up to and including $100,000 pays 15 bps; above $100,000 pays 10 bps.

**First-swap promotion.** On a wallet's first swap, the first $1,000 is free and the base rate applies only to the part above $1,000. The tier is still chosen by the full swap size. Examples: a $1,500 first swap at 20 bps pays on $500 ($1.00); a $50,000 first swap pays 15 bps on $49,000 ($73.50).

**Rounding.** Fees are computed in input-token base units and every division rounds down, in the user's favour. USD values are integer cents. (Clarified in ADR 0004: the USD value is floored to whole cents before the tier is chosen. That is not always in the user's favour. A swap less than one cent above a tier boundary can land in the dearer tier, but never in a cheaper one.)

**Signed fee amount.** A partial waiver gives fees that are not a whole number of basis points, so the backend signs the exact fee amount into each quote (EIP-712) rather than a rate. The fee wrapper checks that the amount is at most 0.3% of the input (`MAX_FEE_BPS`) and charges it exactly.

## Consequences

- The fee shown before signing is exactly the fee charged.
- Future discounts (e.g. VIP tiers) need no contract change as long as they stay under the cap.
- Changing the quote's fee field is a contract change and needs a security review and re-audit.

# Ranvier: technical overview

Ranvier is a non-custodial, multi-chain token swap aggregator. It finds the best net price (after gas and fees) across DEX aggregators and bridges, for swaps on one chain or across chains.

## Scope

| Area     | v1                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chains   | Live EVM chains (rolled out progressively) and Solana, including EVM to Solana swaps                                                                         |
| Channels | Web (Next.js) and Android (React Native)                                                                                                                     |
| Routing  | Meta-aggregator: same-chain providers (e.g. 0x, 1inch, ParaSwap, OpenOcean, KyberSwap), cross-chain providers (e.g. LI.FI, Socket, Rango), Jupiter on Solana |

Later phases add own routing on high-volume pairs, split routes, market-maker quotes, iOS, a public API and an embeddable widget.

## Fee schedule

The fee is taken from the input token, before the swap, on the source chain.

| Swap                                     | Fee   |
| ---------------------------------------- | ----- |
| Under $10,000                            | 0.2%  |
| $10,000 to $100,000                      | 0.15% |
| Above $100,000                           | 0.1%  |
| Major stablecoin to stablecoin           | 0.05% |
| Native wrap/unwrap                       | Free  |
| First swap per new wallet (up to $1,000) | Free  |

The backend signs the rate into each quote (EIP-712). The contract only accepts signed rates and enforces a hard cap of 0.3%. See [ADR 0002](adr/0002-fee-schedule-semantics.md).

## Architecture

- Monorepo (pnpm + Turborepo): `apps/web`, `apps/api`, `apps/workers`, `packages/*`, `contracts`. See [ADR 0001](adr/0001-monorepo.md).
- API-first, hexagonal backend: routing providers, chains and bridges are adapters behind common interfaces. One slow or failing provider never blocks a quote.
- Chain families (EVM, Solana) are isolated modules. Chains are added through config, not code.
- Chains are listed and delisted automatically against health criteria (DEX liquidity, pool depth, chain liveness, RPC availability, routing support).
- Everything is self-hosted; no managed hosting or database platforms.

## Fee wrapper (EVM)

`contracts/src/FeeWrapper.sol`:

- Takes the fee from the input token, then forwards the rest to an allowlisted router.
- Never holds funds between transactions; unspent input and any output paid to the contract go back to the user in the same transaction.
- Only calls allowlisted routers, with calldata bound to the signed quote.
- Checks that the user received at least the quoted minimum (balance difference); positive slippage stays with the user.
- Uses exact approvals that are reset after each swap.
- Pausable by a guardian; only the admin can unpause. Immutable, with versioned redeploys instead of upgradeable proxies.

The contract is **unaudited**. It will not be deployed to mainnet before two independent audits.

## Engineering standards

- TypeScript strict mode; money as integer base units (`bigint`), USD as integer cents.
- 90%+ test coverage on fee, quote and routing logic; 100% line and branch coverage target on the fee wrapper, with fuzz and invariant tests.
- CI on every change: lint, type-check, tests, build, Slither, secret scanning.
- Conventional commits; every significant decision recorded as an ADR in [docs/adr/](adr/).

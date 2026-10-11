# Ranvier

Multi-chain token swap aggregator: best net price across DEXs and bridges, on EVM chains and Solana, with safety checks before you sign. Built by Starterdot LTD.

See the [technical overview](docs/overview.md). Architecture decisions are in [docs/adr/](docs/adr/).

## Repository

| Path              | What                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `apps/web`        | Next.js web app (Direction B design), standalone build for self-hosting |
| `apps/api`        | Quote API (Fastify): provider orchestration with timeouts, fee schedule |
| `apps/workers`    | Scheduled jobs: daily chain health and listing checks                   |
| `packages/types`  | Shared domain types                                                     |
| `packages/chains` | Chain registry, stablecoin allowlist, listing criteria                  |
| `packages/fees`   | Fee schedule (0.2% / 0.15% / 0.1%, 0.05% stables, free wraps)           |
| `contracts`       | Foundry: `FeeWrapper.sol`, the EVM fee wrapper                          |

## Getting started

Requires Node 26+, pnpm 12, and either Foundry or Docker for the contracts.

```sh
git clone --recurse-submodules <repo-url>
pnpm install
pnpm build
pnpm test
pnpm --filter @ranvier/web dev      # http://localhost:3000
pnpm --filter @ranvier/api dev      # http://127.0.0.1:4000/health
```

## Status

Pre-alpha. The fee wrapper is **unaudited** and must not be deployed to mainnet before two independent audits (spec section 9).

# Ranvier

Multi-chain swap aggregator. Public summary: [docs/overview.md](docs/overview.md). Decisions are recorded in [docs/adr/](docs/adr/).

The full internal spec lives at `docs/private/spec.md`. It is git-ignored and never committed, because the repo is public; ask the owner for a copy if it is missing. "The spec" and "section N" below refer to that file.

## Layout

- `apps/web`: Next.js web app (standalone build, self-hosted)
- `apps/api`: Fastify quote and swap API (hexagonal: `domain`, `ports`, `adapters`)
- `apps/workers`: background jobs (chain health checks)
- `packages/types`: shared domain types
- `packages/chains`: chain registry and listing criteria (config, not code)
- `packages/fees`: fee schedule (section 2 of the spec)
- `contracts`: Foundry project for the EVM fee wrapper

## Commands

- `pnpm install`, `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`
- Contracts: `pnpm --filter @ranvier/contracts build` / `test` (runs Foundry in Docker if `forge` is not installed)

## Rules

- TypeScript strict everywhere; no `any`.
- Money amounts are `bigint` base units; USD values are integer cents. Never use floats for money.
- Fee rates are basis points and must never exceed the contract cap (30 bps).

## UI work

Follow [docs/ui-guidelines.md](docs/ui-guidelines.md) exactly: token names from the design handoff, one source of truth for every value, reuse components, match the design canvas to the pixel at 1440, 1200, 768 and 390 px, no hard-coded numbers or promises in copy (derive them from `@ranvier/fees` and `@ranvier/chains`), handle every state, WCAG 2.1 AA. A screen is done only when the verification list in that file passes. If code, canvas and spec disagree, stop and report instead of choosing silently.

## Model use

Follow section 13 of the project spec. You are the coordinator. Never do work from the Opus list yourself: always delegate it to the matching agent (architect, contract-engineer, routing-engineer, security-reviewer), including follow-up fixes. Every diff that touches contracts, fees, treasury, keys, auth or signing goes to security-reviewer before it is called done. Hand UI work to ui-builder, tests to test-writer and chores to chore-runner.

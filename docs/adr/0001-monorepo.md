# ADR 0001: pnpm + Turborepo monorepo

- Status: accepted
- Date: 2026-10-11

## Context

Web, mobile, API, workers and contracts share chain configs, token lists, quote types and fee logic (spec sections 8 and 9).

## Decision

One repository with pnpm workspaces and Turborepo. Apps live in `apps/*`, shared code in `packages/*`, Solidity in `contracts` (Foundry, with forge-std and OpenZeppelin as git submodules). TypeScript strict mode is set once in `tsconfig.base.json`.

## Consequences

- Shared packages are built to `dist/` and consumed through workspace dependencies, so package boundaries are real.
- `apps/mobile` (React Native, Android first) is added as a separate workspace once the web swap flow is working.

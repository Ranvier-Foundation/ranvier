# Runbook: adding or moving a dependency

Every package version that reaches `pnpm-lock.yaml`, direct or transitive, is code that runs on a developer machine, in CI and, for runtime dependencies, next to the quote signer. These rules keep that set small, reviewed and old enough that a hijacked release is usually caught and pulled before it can reach us.

**Every PR that adds, removes or moves a dependency, or changes the supply-chain settings in `pnpm-workspace.yaml`, goes to the security reviewer.**

## The rules

- **Exact pins.** `package.json` names an exact version (`"viem": "2.56.9"`), never a range. Transitive versions are fixed by the lockfile.
- **At least 14 days old.** pnpm enforces this: `minimumReleaseAge: 20160` (minutes) in `pnpm-workspace.yaml`. A fresh resolution only picks versions published at least 14 days ago, and `pnpm install --frozen-lockfile` (what CI runs) fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` if any lockfile entry is younger. If a direct pin or a required range has no mature version, the install fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Do not approve picks interactively; either pick an older version or use the exclude list below.
- **No install scripts.** Only packages listed in `allowBuilds` (today only `esbuild`) may run `preinstall`, `install` or `postinstall`. A new package that needs one is a design decision, not a routine bump.
- **One version per package where we can.** For example, `viem` and its `ox` are the same version in `apps/api` and `apps/web`.
- **The AWS SDK chain is pinned in `overrides`** (ADR 0005). After any change near `@aws-sdk/*` or `@smithy/*`, run `pnpm --filter @ranvier/api check:aws-overrides`.

## Adding a dependency, step by step

1. Ask whether it is needed. Every new package and every new transitive package needs a reason in the PR.
2. Choose the version: the newest release that is at least 14 days old and has no open advisory.

   ```sh
   npm view <pkg> time --json          # publish date of every version
   gh api "/advisories?ecosystem=npm&affects=<pkg>"
   ```

3. Check the version for install scripts, and record what you find in the PR:

   ```sh
   npm view <pkg>@<version> scripts    # must not contain preinstall, install or postinstall
   ```

4. Check provenance and the publisher:

   ```sh
   npm view <pkg>@<version> dist.attestations.provenance   # SLSA provenance, if the project publishes it
   npm view <pkg>@<version> maintainers repository
   ```

   A package that used to publish with provenance and stopped, or a new maintainer on an old package, needs an explanation before it goes in.

5. Add it with an exact pin (`pnpm --filter <workspace> add -E <pkg>@<version>`) and look at what else entered the lockfile: `git diff pnpm-lock.yaml` and `pnpm why -r <pkg>`. Repeat steps 3 and 4 for every new transitive package.
6. Run the full check list: `pnpm install --frozen-lockfile`, `pnpm turbo run build test typecheck lint --filter='!@ranvier/contracts'`, `pnpm format:check`, `pnpm guard:tokens`, `pnpm audit --prod --audit-level high`, and the Playwright suite for anything in `apps/web`.
7. Open the PR with the versions, their publish dates, the script and provenance results, and the reason. It goes to the security reviewer.

## The exclude list

`minimumReleaseAgeExclude` in `pnpm-workspace.yaml` lets in exact versions that are younger than 14 days. Use it only when waiting is worse than the risk of a fresh release, typically:

- a release that fixes a security problem in a package we run (moving back would drop the fix);
- a version already in the lockfile that cannot be moved back without moving something that has a fix or is a deliberate pin.

How to add an entry:

- Always an exact `name@version`, never a bare name or a pattern, so the entry cannot let in a later release.
- A comment for each entry, or for each group of entries that share a reason, saying why it is needed, plus the publish date and the first UTC day on which the version is 14 days old (`# published 2026-10-10; remove on or after 2026-10-25`).
- The PR says why the exclusion was chosen over moving the package.

When to remove entries: on or after the date in its comment. Removing an expired entry changes nothing else (the version is now old enough), so it needs no lockfile change. Check with `pnpm install --frozen-lockfile`. If the package has been bumped since, the entry for the old version is dead and should go as well. Review the list whenever you touch dependencies.

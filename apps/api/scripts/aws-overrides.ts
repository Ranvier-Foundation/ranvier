/**
 * Checks that the pnpm `overrides` pinning the AWS SDK's transitive packages (ADR 0005) still
 * hold: every locked `@aws-sdk/*` and `@smithy/*` package is either the direct pin or exactly
 * its override, and every dependency range declared by those packages accepts the pinned
 * version. pnpm applies overrides even when they break a range, so this is checked here.
 */

/**
 * Scopes whose packages must all be pinned (the direct client-kms pin excepted). `@aws/` covers
 * `@aws/lambda-invoke-store`, a dependency of `@aws-sdk/core` on the credential path.
 */
export const PINNED_SCOPES = ['@aws-sdk/', '@smithy/', '@aws/'] as const;

export interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

/** `name -> version` from the `overrides:` block of pnpm-workspace.yaml. */
export function parseOverrides(workspaceYaml: string): Map<string, string> {
  const out = new Map<string, string>();
  let inBlock = false;
  for (const line of workspaceYaml.split('\n')) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\S/.test(line)) break; // next top-level key
    const m = /^\s+'?([^'\s:]+(?:\/[^'\s:]+)?)'?:\s*'?([^'\s#]+)'?\s*$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * `name -> versions` for every package in the `packages:` sections of pnpm-lock.yaml. The file
 * can hold several YAML documents (pnpm 11+ writes its own package-manager dependencies first),
 * so every `packages:` section is read.
 */
export function lockedPackages(lockYaml: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let inPackages = false;
  for (const line of lockYaml.split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const m = /^ {2}'?((?:@[^/@\s]+\/)?[^@\s']+)@([^(:'\s]+)/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const versions = out.get(m[1]) ?? new Set<string>();
    versions.add(m[2]);
    out.set(m[1], versions);
  }
  return out;
}

type Version = [number, number, number];

function parseVersion(v: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`unsupported version "${v}" (expected x.y.z)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether `version` satisfies `range`. Supports exactly what the AWS SDK uses: `x.y.z`,
 * `^x.y.z`, `~x.y.z`, `>=x.y.z`, and space-separated combinations. Anything else throws, so
 * an unexpected range fails the check instead of passing it.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const m = /^(\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(part);
      if (!m?.[2]) throw new Error(`unsupported range "${range}"`);
      const base = parseVersion(m[2]);
      if (m[1] === '>=') return compare(v, base) >= 0;
      if (compare(v, base) < 0) return false;
      if (m[1] === '^') {
        if (base[0] > 0) return v[0] === base[0];
        if (base[1] > 0) return v[0] === 0 && v[1] === base[1];
        return v[0] === 0 && v[1] === 0 && v[2] === base[2];
      }
      if (m[1] === '~') return v[0] === base[0] && v[1] === base[1];
      return compare(v, base) === 0;
    });
}

export interface CheckInput {
  overrides: Map<string, string>;
  locked: Map<string, Set<string>>;
  /** Manifests of every locked package in the pinned scopes (and the direct pin). */
  manifests: readonly Manifest[];
  /** Packages in the pinned scopes that are pinned directly instead of by override. */
  directPins: ReadonlySet<string>;
}

/** Returns a list of problems; empty means the pinned set is consistent. */
export function checkOverrides(input: CheckInput): string[] {
  const { overrides, locked, manifests, directPins } = input;
  const problems: string[] = [];
  // Guard against a vacuous pass (no overrides parsed, or the SDK not installed at all).
  if (overrides.size === 0) problems.push('no overrides found in pnpm-workspace.yaml');
  for (const pin of directPins) {
    if (!locked.has(pin)) problems.push(`${pin}: direct pin is not in the lockfile`);
  }
  for (const [name, version] of overrides) {
    const versions = locked.get(name);
    if (!versions) problems.push(`${name}: overridden to ${version} but not in the lockfile`);
    else if (versions.size !== 1 || !versions.has(version)) {
      problems.push(`${name}: lockfile has ${[...versions].join(', ')}, override is ${version}`);
    }
  }
  for (const [name, versions] of locked) {
    if (!PINNED_SCOPES.some((s) => name.startsWith(s))) continue;
    if (!overrides.has(name) && !directPins.has(name)) {
      problems.push(
        `${name}@${[...versions].join(', ')}: not pinned in pnpm-workspace.yaml overrides`,
      );
    }
  }
  for (const m of manifests) {
    for (const [dep, range] of Object.entries(m.dependencies ?? {})) {
      const pinned = overrides.get(dep);
      if (pinned === undefined) continue;
      let ok: boolean;
      try {
        ok = satisfies(pinned, range);
      } catch (err: unknown) {
        problems.push(
          `${m.name}@${m.version} -> ${dep}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!ok) problems.push(`${m.name}@${m.version} needs ${dep}@${range}, pinned ${pinned}`);
    }
  }
  return problems;
}

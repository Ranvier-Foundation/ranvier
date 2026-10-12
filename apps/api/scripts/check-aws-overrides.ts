/**
 * CI check (ADR 0005): the pnpm overrides for the AWS SDK's transitive packages match the
 * lockfile and satisfy every declared dependency range. Run after `pnpm install`:
 *
 *   pnpm --filter @ranvier/api check:aws-overrides
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  checkOverrides,
  lockedPackages,
  parseOverrides,
  PINNED_SCOPES,
  type Manifest,
} from './aws-overrides.js';

const root = resolve(import.meta.dirname, '../../..');
const store = join(root, 'node_modules/.pnpm');
const directPins = new Set(['@aws-sdk/client-kms']);

const overrides = parseOverrides(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
const locked = lockedPackages(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));

/** The installed package.json of `name@version` in pnpm's virtual store. */
function manifest(name: string, version: string): Manifest {
  const prefix = `${name.replace('/', '+')}@${version}`;
  const dir = readdirSync(store).find((d) => d === prefix || d.startsWith(`${prefix}_`));
  const file = dir && join(store, dir, 'node_modules', name, 'package.json');
  if (!file || !existsSync(file)) throw new Error(`${name}@${version} is not installed`);
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

const manifests: Manifest[] = [];
for (const [name, versions] of locked) {
  if (!PINNED_SCOPES.some((s) => name.startsWith(s))) continue;
  for (const version of versions) manifests.push(manifest(name, version));
}

const problems = checkOverrides({ overrides, locked, manifests, directPins });
if (problems.length > 0) {
  console.error('AWS SDK overrides are inconsistent:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `AWS SDK overrides OK: ${overrides.size} pinned, ${manifests.length} manifests checked.`,
);

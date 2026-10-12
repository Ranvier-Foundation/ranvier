import { describe, expect, it } from 'vitest';
import { checkOverrides, lockedPackages, parseOverrides, satisfies } from './aws-overrides.js';

const WORKSPACE = `packages:
  - apps/*

overrides:
  '@aws-sdk/core': 3.978.1
  '@smithy/core': 3.35.1
  '@smithy/types': 4.19.0
  plain-pkg: 1.0.0

allowBuilds:
  esbuild: true
`;

const LOCK = `lockfileVersion: '9.0'

importers:
  apps/api:
    dependencies:
      '@aws-sdk/client-kms':
        specifier: 3.1141.0

packages:

  '@aws-sdk/client-kms@3.1141.0':
    resolution: {integrity: sha512-x}

  '@aws-sdk/core@3.978.1':
    resolution: {integrity: sha512-x}

  '@smithy/core@3.35.1':
    resolution: {integrity: sha512-x}

  plain-pkg@1.0.0:
    resolution: {integrity: sha512-x}

  vite@8.3.4(@types/node@26.6.5):
    resolution: {integrity: sha512-x}

snapshots:

  '@aws-sdk/core@3.978.2': {}

---
lockfileVersion: '9.0'

packages:

  '@smithy/types@4.19.0':
    resolution: {integrity: sha512-x}
`;

describe('parseOverrides', () => {
  it('reads the overrides block only', () => {
    expect([...parseOverrides(WORKSPACE)]).toEqual([
      ['@aws-sdk/core', '3.978.1'],
      ['@smithy/core', '3.35.1'],
      ['@smithy/types', '4.19.0'],
      ['plain-pkg', '1.0.0'],
    ]);
    expect(parseOverrides('packages:\n  - a\n').size).toBe(0);
  });
});

describe('lockedPackages', () => {
  it('reads package keys from the packages section, not snapshots', () => {
    const locked = lockedPackages(LOCK);
    expect(locked.get('@aws-sdk/core')).toEqual(new Set(['3.978.1']));
    expect(locked.get('@aws-sdk/client-kms')).toEqual(new Set(['3.1141.0']));
    expect(locked.get('plain-pkg')).toEqual(new Set(['1.0.0']));
    expect(locked.get('vite')).toEqual(new Set(['8.3.4']));
    // A second YAML document's packages section is read too.
    expect(locked.get('@smithy/types')).toEqual(new Set(['4.19.0']));
    expect(lockedPackages('lockfileVersion: 9\n').size).toBe(0);
  });
});

describe('satisfies', () => {
  it.each([
    ['3.978.1', '^3.978.1', true],
    ['3.979.0', '^3.978.1', true],
    ['4.0.0', '^3.978.1', false],
    ['3.978.0', '^3.978.1', false],
    ['0.3.5', '^0.3.0', true],
    ['0.4.0', '^0.3.0', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['2.0.0', '>=1.2.3', true],
    ['1.2.2', '>=1.2.3', false],
    ['1.5.0', '>=1.2.3 ^1.0.0', true],
  ])('%s satisfies %s: %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('fails closed on syntax it does not understand', () => {
    for (const range of ['*', '1.x', '<2.0.0', '^1.2', 'workspace:*', '1.0.0 || 2.0.0']) {
      expect(() => satisfies('1.0.0', range), range).toThrow('unsupported range');
    }
    expect(() => satisfies('1.0.0-beta.1', '^1.0.0')).toThrow('unsupported version');
  });
});

describe('checkOverrides', () => {
  const overrides = parseOverrides(WORKSPACE);
  const directPins = new Set(['@aws-sdk/client-kms']);
  const manifests = [
    {
      name: '@aws-sdk/client-kms',
      version: '3.1141.0',
      dependencies: { '@aws-sdk/core': '^3.978.1', '@smithy/core': '^3.35.0', tslib: '^2.6.2' },
    },
    { name: '@aws-sdk/core', version: '3.978.1', dependencies: { '@smithy/core': '^3.35.0' } },
    { name: '@smithy/core', version: '3.35.1' },
  ];

  it('accepts a consistent set', () => {
    expect(
      checkOverrides({ overrides, locked: lockedPackages(LOCK), manifests, directPins }),
    ).toEqual([]);
  });

  it('reports a range the override breaks', () => {
    const broken = [
      ...manifests,
      { name: '@aws-sdk/core', version: '3.978.1', dependencies: { '@smithy/core': '^3.36.0' } },
    ];
    expect(
      checkOverrides({ overrides, locked: lockedPackages(LOCK), manifests: broken, directPins }),
    ).toEqual(['@aws-sdk/core@3.978.1 needs @smithy/core@^3.36.0, pinned 3.35.1']);
  });

  it('reports an exact pin to another version and unsupported ranges', () => {
    const exact = [
      { name: '@aws-sdk/x', version: '1.0.0', dependencies: { '@aws-sdk/core': '3.978.2' } },
      { name: '@aws-sdk/y', version: '1.0.0', dependencies: { '@aws-sdk/core': '3.x' } },
    ];
    expect(
      checkOverrides({ overrides, locked: lockedPackages(LOCK), manifests: exact, directPins }),
    ).toEqual([
      '@aws-sdk/x@1.0.0 needs @aws-sdk/core@3.978.2, pinned 3.978.1',
      '@aws-sdk/y@1.0.0 -> @aws-sdk/core: unsupported range "3.x"',
    ]);
  });

  it('reports lockfile drift, missing overrides and unpinned packages', () => {
    const drifted = LOCK.replace("'@aws-sdk/core@3.978.1'", "'@aws-sdk/core@3.978.2'")
      .replace(
        "'@smithy/core@3.35.1':",
        "'@smithy/core@3.35.1':\n    x: y\n\n  '@smithy/core@3.35.2':",
      )
      .replace('plain-pkg@1.0.0:', "'@smithy/new@1.0.0':");
    expect(
      checkOverrides({ overrides, locked: lockedPackages(drifted), manifests: [], directPins }),
    ).toEqual([
      '@aws-sdk/core: lockfile has 3.978.2, override is 3.978.1',
      '@smithy/core: lockfile has 3.35.1, 3.35.2, override is 3.35.1',
      'plain-pkg: overridden to 1.0.0 but not in the lockfile',
      '@smithy/new@1.0.0: not pinned in pnpm-workspace.yaml overrides',
    ]);
  });
});

/**
 * The published-address list and its startup check (ADR 0013, section 4), and the cross-check
 * that this list is exactly `isPublishedDevAddress` in `contracts/script/Deploy.s.sol`, so the
 * API and the deploy guard can never disagree. Addresses only: the derivation of the mnemonic
 * accounts from the published mnemonic is checked next to the harness scripts, which may hold it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  assertNotPublishedSigner,
  isPublishedDevAddress,
  MAX_RESERVED_ADDRESS,
  PUBLISHED_MNEMONIC_ACCOUNTS,
  PUBLISHED_SIGNER_CHAIN_ID,
  PUBLISHED_TOOLING_ADDRESSES,
} from './published-addresses.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DEPLOY_SOL = readFileSync(`${REPO}contracts/script/Deploy.s.sol`, 'utf8');

/** The body of `function isPublishedDevAddress(...)` in Deploy.s.sol. */
function solidityGuardBody(): string {
  const start = DEPLOY_SOL.indexOf('function isPublishedDevAddress(address a)');
  expect(start).toBeGreaterThan(0);
  const open = DEPLOY_SOL.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < DEPLOY_SOL.length; i++) {
    if (DEPLOY_SOL[i] === '{') depth++;
    if (DEPLOY_SOL[i] === '}' && --depth === 0) return DEPLOY_SOL.slice(open, i + 1);
  }
  throw new Error('unterminated isPublishedDevAddress');
}

/** `address public constant NAME = 0x...;` in Deploy.s.sol, or in forge-std when present. */
function solidityConstant(source: string, name: string): string | undefined {
  const m = new RegExp(`address (?:public|internal) constant ${name} = (0x[0-9a-fA-F]{40});`).exec(
    source,
  );
  return m?.[1];
}

/**
 * forge-std's constants (Base.sol), recorded here because the JS CI job does not check out
 * contract submodules; compared with forge-std itself when it is checked out (below).
 */
const FORGE_STD = {
  CREATE2_FACTORY: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  DEFAULT_SENDER: '0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38',
  DEFAULT_TEST_CONTRACT: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f',
} as const;

describe('the TS list equals Deploy.s.sol isPublishedDevAddress (no drift)', () => {
  const body = solidityGuardBody();

  it('the 30 mnemonic accounts, in the same order and checksummed spelling', () => {
    const list = /address\[(\d+)\] memory accounts = \[([^\]]*)\]/.exec(body);
    expect(list).not.toBeNull();
    const solidity = [...(list?.[2] ?? '').matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]);
    expect(Number(list?.[1])).toBe(solidity.length);
    expect(solidity).toEqual(PUBLISHED_MNEMONIC_ACCOUNTS.map((a) => getAddress(a)));
    expect(PUBLISHED_MNEMONIC_ACCOUNTS).toHaveLength(30);
  });

  it('the reserved range bound, the named tooling constants and the burn literals', () => {
    expect(body).toContain(`uint160(a) <= 0x${MAX_RESERVED_ADDRESS.toString(16)}`);
    // Every address literal in the function outside the accounts array: the two burn addresses.
    const outside = body.replace(/address\[\d+\] memory accounts = \[[^\]]*\]/, '');
    const literals = [...outside.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase());
    // Every named address constant it compares with.
    const named = [...outside.matchAll(/a == ([A-Z][A-Z0-9_]+)/g)].map((m) => m[1] ?? '');
    expect(named.sort()).toEqual(
      ['CREATE2_FACTORY', 'DEFAULT_SENDER', 'DEFAULT_TEST_CONTRACT', 'FORGE_TEST_CONTRACT'].sort(),
    );
    const resolved = named.map((name) =>
      (name === 'FORGE_TEST_CONTRACT'
        ? solidityConstant(DEPLOY_SOL, name)
        : FORGE_STD[name as keyof typeof FORGE_STD]
      )?.toLowerCase(),
    );
    expect([...literals, ...resolved].sort()).toEqual([...PUBLISHED_TOOLING_ADDRESSES].sort());
  });

  const base = `${REPO}contracts/lib/forge-std/src/Base.sol`;
  it.skipIf(!existsSync(base))('forge-std (when checked out) has the recorded constants', () => {
    const source = readFileSync(base, 'utf8');
    for (const [name, value] of Object.entries(FORGE_STD)) {
      expect(solidityConstant(source, name)).toBe(value);
    }
  });
});

describe('isPublishedDevAddress', () => {
  it.each([...PUBLISHED_MNEMONIC_ACCOUNTS, ...PUBLISHED_TOOLING_ADDRESSES])(
    'refuses %s in every letter case',
    (a) => {
      expect(isPublishedDevAddress(a)).toBe(true);
      expect(isPublishedDevAddress(getAddress(a))).toBe(true);
      expect(isPublishedDevAddress(`0x${a.slice(2).toUpperCase()}`)).toBe(true);
    },
  );

  it('refuses address(0) and everything up to 0x...01ff, and nothing just above it', () => {
    const at = (n: bigint): string => `0x${n.toString(16).padStart(40, '0')}`;
    for (const n of [0n, 1n, 2n, 0x100n, 0x1fen, 0x1ffn])
      expect(isPublishedDevAddress(at(n))).toBe(true);
    expect(isPublishedDevAddress(at(0x200n))).toBe(false);
  });

  it('accepts an ordinary address and fails closed on anything that is not one', () => {
    expect(isPublishedDevAddress('0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7')).toBe(false);
    for (const bad of ['', '0x', '0x1234', 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0xzz']) {
      expect(isPublishedDevAddress(bad)).toBe(true);
    }
  });

  it('the lists are frozen', () => {
    expect(Object.isFrozen(PUBLISHED_MNEMONIC_ACCOUNTS)).toBe(true);
    expect(Object.isFrozen(PUBLISHED_TOOLING_ADDRESSES)).toBe(true);
    expect(PUBLISHED_SIGNER_CHAIN_ID).toBe(31337);
  });
});

describe('assertNotPublishedSigner', () => {
  const published = getAddress(PUBLISHED_MNEMONIC_ACCOUNTS[1] ?? '');
  const own = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7';

  it('accepts a published signer when every quoted chain is 31337', () => {
    expect(() => assertNotPublishedSigner(published, [31337], 'x')).not.toThrow();
    expect(() => assertNotPublishedSigner(published, [31337, 31337], 'x')).not.toThrow();
  });

  it.each([[[1]], [[8453, 31337]], [[84532]], [[11155111]], [[421614]], [[31337, 1]], [[]]])(
    'refuses a published signer for chains %j',
    (chains) => {
      expect(() => assertNotPublishedSigner(published, chains, 'The signer')).toThrow(
        /^The signer is 0x70997970C51812dc3A010C7d01b50e0d17dc79C8, a published development address/,
      );
    },
  );

  it('names the chains other than 31337', () => {
    expect(() => assertNotPublishedSigner(published, [31337, 8453, 1], 'K')).toThrow(
      'ZEROX_CHAIN_IDS includes chain(s) 8453, 1 other than the local chain 31337',
    );
  });

  it('accepts any other address on any chain', () => {
    expect(() => assertNotPublishedSigner(own, [1, 8453, 42161], 'x')).not.toThrow();
  });
});

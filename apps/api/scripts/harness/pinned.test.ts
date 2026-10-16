import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { anvilAccount, devAccounts, publicAnvilKey } from './dev-accounts.js';
import {
  ACCOUNT_INDEX,
  ETH_USD,
  FEE_WRAPPER_SALT,
  PINNED,
  RUNBOOK_NAMES,
  SOLIDITY_NAMES,
  type PinnedName,
} from './pinned.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SOLIDITY = read('../../../../contracts/test/harness/HarnessConfig.sol');
const RUNBOOK = read('../../../../docs/runbooks/local-harness.md');

function solidityConstant(name: string): string | undefined {
  return new RegExp(`constant ${name} = (0x[0-9a-fA-F]+|[0-9_]+);`).exec(SOLIDITY)?.[1];
}

function runbookAddress(label: string): string | undefined {
  const escaped = label.replace(/[()]/g, '\\$&');
  return new RegExp(`^\\| ${escaped}\\s+\\|[^\\n]*\`(0x[0-9a-fA-F]{40})\``, 'm').exec(RUNBOOK)?.[1];
}

describe('the pinned table is the one HarnessConfig.sol and the runbook pin', () => {
  it.each(Object.keys(PINNED) as PinnedName[])('%s', (name) => {
    expect(solidityConstant(SOLIDITY_NAMES[name])).toBe(PINNED[name]);
    expect(runbookAddress(RUNBOOK_NAMES[name])).toBe(PINNED[name]);
  });

  it('salt and price constants match', () => {
    expect(solidityConstant('FEE_WRAPPER_SALT')).toBe(FEE_WRAPPER_SALT);
    expect(RUNBOOK).toContain(`FEE_WRAPPER_SALT=${FEE_WRAPPER_SALT}`);
    expect(solidityConstant('ETH_USD')?.replaceAll('_', '')).toBe(ETH_USD.toString());
  });
});

describe('dev accounts (PUBLIC anvil keys, chain 31337 only)', () => {
  const accounts = devAccounts();

  it('derive to the role addresses HarnessConfig.sol and the runbook use', () => {
    const roles: [string, string, string][] = [
      ['DEPLOYER', accounts.deployer, 'deployer, owner, guardian'],
      ['FEE_SIGNER', accounts.feeSigner.address, 'fee signer (API local key)'],
      ['USER', accounts.user.address, 'test user (browser wallet)'],
      ['FEE_COLLECTOR', accounts.collector, 'fee collector'],
    ];
    for (const [sol, address, label] of roles) {
      expect(solidityConstant(sol)).toBe(address);
      expect(runbookAddress(label)).toBe(address);
    }
    expect(solidityConstant('FEE_SIGNER_INDEX')).toBe(String(ACCOUNT_INDEX.feeSigner));
  });

  it('the in-memory key belongs to its account (never printed)', () => {
    const account = anvilAccount(ACCOUNT_INDEX.feeSigner);
    expect(privateKeyToAccount(publicAnvilKey(account)).address).toBe(account.address);
  });
});

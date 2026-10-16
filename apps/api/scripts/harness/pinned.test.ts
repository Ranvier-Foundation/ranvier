import {
  LOCAL_DEV_CHAIN,
  LOCAL_DEV_CHAIN_ID,
  LOCAL_DEV_CONTRACTS,
  localDevAddresses,
  localDevToken,
  type ScenarioTokenSymbol,
} from '@ranvier/chains/local-dev';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { anvilAccount, devAccounts, publicAnvilKey } from '../../src/harness/dev-accounts.js';
import {
  ACCOUNT_INDEX,
  ETH_USD,
  FEE_WRAPPER_SALT,
  HARNESS_CHAIN_ID,
  HARNESS_CHAIN_KEY,
  LISTED_TOKENS,
  PINNED,
  RUNBOOK_NAMES,
  SOLIDITY_NAMES,
  type PinnedName,
} from '../../src/harness/pinned.js';

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

describe('@ranvier/chains/local-dev is the table HarnessConfig.sol and the runbook pin', () => {
  /** Every address local-dev pins, by its HarnessConfig.sol name and runbook label. */
  const rows: [string, string, string][] = [
    ['ALLOWANCE_HOLDER', 'MockAllowanceHolder', LOCAL_DEV_CONTRACTS.allowanceHolder],
    ['SETTLER', 'MockSettler', LOCAL_DEV_CONTRACTS.settler],
    ['HUSDC', 'hUSDC (6)', localDevToken('hUSDC').address],
    ['HWETH', 'hWETH (18)', localDevToken('hWETH').address],
    ['FEE_WRAPPER', 'FeeWrapper', LOCAL_DEV_CONTRACTS.feeWrapper],
    ...(Object.entries(LOCAL_DEV_CONTRACTS.scenarioTokens) as [ScenarioTokenSymbol, string][]).map(
      ([symbol, address]): [string, string, string] => [
        symbol.toUpperCase(),
        symbol === 'hUSDT' ? 'hUSDT (USDT-style)' : symbol,
        address,
      ],
    ),
  ];

  it.each(rows)('%s', (solidity, runbook, address) => {
    expect(solidityConstant(solidity)).toBe(getAddress(address));
    expect(runbookAddress(runbook)).toBe(getAddress(address));
  });

  it('covers every row of the runbook table and every address constant of HarnessConfig.sol', () => {
    const table = RUNBOOK.slice(RUNBOOK.indexOf('### Address table'));
    const tabled = [
      ...table.slice(0, table.indexOf('\n## ')).matchAll(/^\|[^\n]*`(0x[0-9a-fA-F]{40})`/gm),
    ].map((m) => m[1]?.toLowerCase());
    expect(tabled.sort()).toEqual(localDevAddresses().sort());
    const roles = ['DEPLOYER', 'FEE_SIGNER', 'USER', 'FEE_COLLECTOR'];
    const constants = [
      ...SOLIDITY.matchAll(/address internal constant (\w+) = (0x[0-9a-fA-F]{40});/g),
    ].flatMap((m) => (m[1] && roles.includes(m[1]) ? [] : [m[2]?.toLowerCase()]));
    expect(constants.sort()).toEqual(localDevAddresses().sort());
  });

  it('the CREATE2 factory, chain ID and token decimals match', () => {
    const factory = getAddress(LOCAL_DEV_CONTRACTS.create2Factory);
    expect(SOLIDITY).toContain(factory);
    expect(RUNBOOK).toContain(`CREATE2 through the factory at \`${factory}\``);
    expect(solidityConstant('CHAIN_ID')).toBe(String(LOCAL_DEV_CHAIN_ID));
    expect(RUNBOOK).toContain(`--chain-id ${LOCAL_DEV_CHAIN_ID}`);
    expect(localDevToken('hUSDC').decimals).toBe(6);
    expect(localDevToken('hWETH').decimals).toBe(18);
  });

  it('pinned.ts takes its chain and addresses from local-dev only', () => {
    expect(HARNESS_CHAIN_ID).toBe(LOCAL_DEV_CHAIN_ID);
    expect(HARNESS_CHAIN_KEY).toBe(LOCAL_DEV_CHAIN.key);
    expect(LISTED_TOKENS.map((t) => t.symbol)).toEqual(['hWETH', 'hUSDC']);
    for (const address of Object.values(PINNED)) {
      expect(localDevAddresses()).toContain(address.toLowerCase());
    }
    // No address literal in the harness sources: they import @ranvier/chains/local-dev.
    const literal = /0x[0-9a-fA-F]{40}\b/;
    for (const file of [
      '../../src/harness/pinned.ts',
      'smoke.ts',
      '../../src/harness/fixtures.ts',
      'anvil.ts',
      '../../src/harness/rpc-guard.ts',
      '../../src/harness/start.ts',
      '../../src/harness/env-guard.ts',
      '../../src/harness/catalog.ts',
      '../../src/harness/main.ts',
    ]) {
      expect(literal.test(read(file)), file).toBe(false);
    }
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

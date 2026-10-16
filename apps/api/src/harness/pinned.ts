/**
 * LOCAL TEST HARNESS ONLY (ADR 0013).
 * Lives in `src/harness/`: excluded from the build (`dist/`), never imported by production code.
 *
 * The pinned table of the harness contracts on a fresh anvil (chain 31337): the CREATE2 results
 * from `contracts/test/harness/HarnessConfig.sol`, also listed in docs/runbooks/local-harness.md,
 * taken from `@ranvier/chains/local-dev` (ADR 0013, section 2). `pinned.test.ts` checks that this
 * table and that module equal both, so a moved mock fails here first. The smoke
 * takes addresses from this table only, never from a deploy log or the environment, and checks the
 * chain against it (code present, EIP-712 domain, roles, router allowlist) before it trusts it.
 *
 * Addresses only: the dev accounts are derived from the published mnemonic in `dev-accounts.ts`.
 */
import {
  LOCAL_DEV_CHAIN,
  LOCAL_DEV_CHAIN_ID,
  LOCAL_DEV_CHAIN_KEY,
  LOCAL_DEV_CONTRACTS,
  localDevToken,
} from '@ranvier/chains/local-dev';
import { getAddress, type Hex } from 'viem';

/**
 * The only chain the harness talks to. 31337 is not reserved: loopback is checked as well.
 *
 * LITERALS on purpose (security review of PR 3, M1): the harness's 31337-only rails (the RPC
 * chain-ID check, anvil's `--chain-id`, the local key's allowlist) must never follow a data
 * constant. If `@ranvier/chains/local-dev` ever names another chain, this module refuses to load
 * (`assertLocalDevChain` below), so no harness code runs at all.
 */
export const HARNESS_CHAIN_ID = 31337;
export const HARNESS_CHAIN_KEY = 'evm:31337' as const;

/** Throws unless the local-dev data is chain 31337 / `evm:31337`. Run at module load. */
export function assertLocalDevChain(chainId: number, key: string, chainIdField: number): void {
  if (chainId !== 31337 || chainIdField !== 31337 || key !== 'evm:31337') {
    throw new Error(
      `@ranvier/chains/local-dev names chain ${String(chainId)} (${key}); the harness runs on ` +
        '31337 only and refuses to load',
    );
  }
}
assertLocalDevChain(LOCAL_DEV_CHAIN_ID, LOCAL_DEV_CHAIN_KEY, LOCAL_DEV_CHAIN.chainId);
assertLocalDevChain(LOCAL_DEV_CHAIN_ID, LOCAL_DEV_CHAIN.key, LOCAL_DEV_CHAIN.chainId);
/** viem chain fields, from the same module. */
export const HARNESS_CHAIN_NAME = LOCAL_DEV_CHAIN.name;
export const HARNESS_NATIVE = localDevToken('ETH');

/**
 * Contract addresses, checksummed. One source: `@ranvier/chains/local-dev` (no literal here);
 * `pinned.test.ts` checks the checksummed form equals HarnessConfig.sol and the runbook exactly.
 */
export const PINNED = Object.freeze({
  allowanceHolder: getAddress(LOCAL_DEV_CONTRACTS.allowanceHolder),
  settler: getAddress(LOCAL_DEV_CONTRACTS.settler),
  hUSDC: getAddress(localDevToken('hUSDC').address),
  hWETH: getAddress(localDevToken('hWETH').address),
  hUNDER: getAddress(LOCAL_DEV_CONTRACTS.scenarioTokens.hUNDER),
  hORACLE: getAddress(LOCAL_DEV_CONTRACTS.scenarioTokens.hORACLE),
  feeWrapper: getAddress(LOCAL_DEV_CONTRACTS.feeWrapper),
} satisfies Record<string, Hex>);

export type PinnedName = keyof typeof PINNED;

/** The tokens `LOCAL_DEV_CHAIN` lists (not the native coin): the smoke checks each on chain. */
export const LISTED_TOKENS = LOCAL_DEV_CHAIN.tokens.filter((t) => t.address !== 'native');

/** Decimals of the two listed harness tokens, from `LOCAL_DEV_CHAIN.tokens`. */
export const pinnedDecimals = (symbol: 'hUSDC' | 'hWETH'): number => localDevToken(symbol).decimals;

/** The names these addresses have in HarnessConfig.sol (`address internal constant <NAME>`). */
export const SOLIDITY_NAMES: Readonly<Record<PinnedName, string>> = {
  allowanceHolder: 'ALLOWANCE_HOLDER',
  settler: 'SETTLER',
  hUSDC: 'HUSDC',
  hWETH: 'HWETH',
  hUNDER: 'HUNDER',
  hORACLE: 'HORACLE',
  feeWrapper: 'FEE_WRAPPER',
};

/** The names these addresses have in the runbook's address table (first column). */
export const RUNBOOK_NAMES: Readonly<Record<PinnedName, string>> = {
  allowanceHolder: 'MockAllowanceHolder',
  settler: 'MockSettler',
  hUSDC: 'hUSDC (6)',
  hWETH: 'hWETH (18)',
  hUNDER: 'hUNDER',
  hORACLE: 'hORACLE',
  feeWrapper: 'FeeWrapper',
};

/** EIP-712 domain the wrapper must report (FeeWrapper's `EIP712("Ranvier FeeWrapper", "1")`). */
export const WRAPPER_DOMAIN = { name: 'Ranvier FeeWrapper', version: '1' } as const;

/**
 * Anvil account indices the runbook deploy used (docs/runbooks/local-harness.md): 0 deploys and is
 * owner and guardian, 1 is the fee signer, 2 the test user, 3 the fee collector.
 */
export const ACCOUNT_INDEX = { deployer: 0, feeSigner: 1, user: 2, collector: 3 } as const;

/** The wrapper deploy salt from the runbook ("RANV"). */
export const FEE_WRAPPER_SALT =
  '0x0000000000000000000000000000000000000000000000000000000052414e56' as const;

/**
 * Prices the settler rates are derived from (HarnessConfig.ETH_USD; every other harness token $1).
 * Whole dollars, so the oracle's `usdE18` is exact.
 */
export const ETH_USD = 3_000n;

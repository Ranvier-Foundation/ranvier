/**
 * LOCAL TEST HARNESS ONLY (ADR 0013). Never imported by `src/`, never built into `dist/`.
 *
 * The pinned table of the harness contracts on a fresh anvil (chain 31337): the CREATE2 results
 * from `contracts/test/harness/HarnessConfig.sol`, also listed in docs/runbooks/local-harness.md.
 * `pinned.test.ts` checks that this table equals both, so a moved mock fails here first. The smoke
 * takes addresses from this table only, never from a deploy log or the environment, and checks the
 * chain against it (code present, EIP-712 domain, roles, router allowlist) before it trusts it.
 *
 * Addresses only: the dev accounts are derived from the published mnemonic in `dev-accounts.ts`.
 */
import type { Hex } from 'viem';

/** The only chain the harness talks to. 31337 is not reserved: loopback is checked as well. */
export const HARNESS_CHAIN_ID = 31337;
export const HARNESS_CHAIN_KEY = 'evm:31337' as const;

/** Contract addresses, checksummed, exactly as in HarnessConfig.sol. */
export const PINNED = {
  allowanceHolder: '0xC0b06d1E9E0bb6e4b5d903A2b5afc57e1bF41Ce2',
  settler: '0x2c7959766740C57e7615b9452FDe5E7273Bb6E3c',
  hUSDC: '0x5784F90419222088aC18AE5B62ef381f4Cb2deB1',
  hWETH: '0x47FA559bE608137ea4D28588b6c57D0D1aC6552D',
  hUNDER: '0x3d186379d8AfB89332aA0b11CFD399d4966Eb917',
  hORACLE: '0xa03B74d8a5289B2A6278554183cE5d51dEb12c09',
  feeWrapper: '0x60A10abb52c31ec38f1f93c70B64D2Fb00913859',
} as const satisfies Record<string, Hex>;

export type PinnedName = keyof typeof PINNED;

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

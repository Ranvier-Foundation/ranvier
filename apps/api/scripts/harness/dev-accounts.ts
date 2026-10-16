/**
 * LOCAL TEST HARNESS ONLY (ADR 0013). Never imported by `src/`, never built into `dist/`.
 *
 * PUBLIC anvil keys, chain 31337 only. They are derived in memory from the published anvil
 * mnemonic (the one every Foundry and Hardhat install prints) and are never written, logged or
 * returned as text. They are worthless and must never be used on any other chain: off 31337,
 * `Deploy.s.sol` refuses these addresses in every role, and the smoke refuses any RPC that is not
 * loopback chain 31337 before it builds a client.
 */
import { toHex, type Hex } from 'viem';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import { ACCOUNT_INDEX } from './pinned.js';

/** PUBLIC anvil mnemonic, chain 31337 only (as `HarnessConfig.ANVIL_MNEMONIC`). Not a secret. */
const PUBLIC_ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

export interface DevAccounts {
  deployer: Hex;
  /** PUBLIC anvil key, chain 31337 only: anvil account 1. Signs fee quotes through LocalKeySigner. */
  feeSigner: HDAccount;
  /** PUBLIC anvil key, chain 31337 only: anvil account 2. Signs the user's transactions locally. */
  user: HDAccount;
  collector: Hex;
}

/** PUBLIC anvil key, chain 31337 only: the HD account at `index` of the published mnemonic. */
export function anvilAccount(index: number): HDAccount {
  return mnemonicToAccount(PUBLIC_ANVIL_MNEMONIC, { addressIndex: index });
}

export function devAccounts(): DevAccounts {
  return {
    deployer: anvilAccount(ACCOUNT_INDEX.deployer).address,
    feeSigner: anvilAccount(ACCOUNT_INDEX.feeSigner),
    user: anvilAccount(ACCOUNT_INDEX.user),
    collector: anvilAccount(ACCOUNT_INDEX.collector).address,
  };
}

/**
 * PUBLIC anvil key, chain 31337 only: the raw key of an HD account, for `LocalKeySigner`, which
 * takes a key. Kept in memory; never print or persist the result.
 */
export function publicAnvilKey(account: HDAccount): Hex {
  const key = account.getHdKey().privateKey;
  if (!key) throw new Error('HD account has no private key');
  return toHex(key);
}

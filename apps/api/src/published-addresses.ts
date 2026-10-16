/**
 * Addresses whose private keys are public, or that no signer may ever be (ADR 0013, section 4).
 *
 * The same list as `isPublishedDevAddress` in `contracts/script/Deploy.s.sol`, which refuses
 * these addresses in every wrapper role off the local chain. `published-addresses.test.ts` here
 * and the cross-check test next to the harness scripts compare the two lists entry by entry, so
 * they cannot drift. ADDRESSES ONLY: no key and no mnemonic is ever held here.
 *
 * A signer at one of these addresses can be impersonated by anyone (its key ships with every
 * Foundry and Hardhat install), so the API refuses to start with one as its quote signer, local
 * key or KMS alike, unless every quoted chain is the local chain 31337. A published key imported
 * into KMS as external key material is still public.
 */

/** Anvil and Hardhat's chain ID: the only chain where a published signer is accepted. A literal. */
export const PUBLISHED_SIGNER_CHAIN_ID = 31337;

/**
 * Accounts 0 to 29 of the published `test test ... junk` mnemonic (m/44'/60'/0'/0/i), lowercase,
 * in index order (Deploy.s.sol lists the same 30).
 */
export const PUBLISHED_MNEMONIC_ACCOUNTS: readonly string[] = Object.freeze([
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9',
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f',
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
  '0xbcd4042de499d14e55001ccbb24a551f3b954096',
  '0x71be63f3384f5fb98995898a86b02fb2426c5788',
  '0xfabb0ac9d68b0b445fb7357272ff202c5651694a',
  '0x1cbd3b2770909d4e10f157cabc84c7264073c9ec',
  '0xdf3e18d64bc6a983f673ab319ccae4f1a57c7097',
  '0xcd3b766ccdd6ae721141f452c550ca635964ce71',
  '0x2546bcd3c84621e976d8185a91a922ae77ecec30',
  '0xbda5747bfd65f08deb54cb465eb87d40e51b197e',
  '0xdd2fd4581271e230360230f9337d5c0430bf44c0',
  '0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199',
  '0x09db0a93b389bef724429898f539aeb7ac2dd55f',
  '0x02484cb50aac86eae85610d6f4bf026f30f6627d',
  '0x08135da0a343e492fa2d4282f2ae34c6c5cc1bbe',
  '0x5e661b79fe2d3f6ce70f5aac07d8cd9abb2743f1',
  '0x61097ba76cd906d2ba4fd106e757f7eb455fc295',
  '0xdf37f81daad2b0327a0a50003740e1c935c70913',
  '0x553bc17a05702530097c3677091c5bb47a3a7931',
  '0x87bdce72c06c21cd96219bd8521bdf1f42c78b5e',
  '0x40fc963a729c542424cd800349a7e4ecc4896624',
  '0x9dcce783b6464611f38631e6c851bf441907c710',
]);

/**
 * Tooling and burn addresses, lowercase, as Deploy.s.sol names them: anvil's CREATE2 factory
 * (forge-std `CREATE2_FACTORY`), forge's default sender (`DEFAULT_SENDER`), the address forge
 * deploys a test contract at (`FORGE_TEST_CONTRACT`), forge-std's `DEFAULT_TEST_CONTRACT`, and
 * the burn addresses 0x...dEaD and 0xdEAD...2069.
 */
export const PUBLISHED_TOOLING_ADDRESSES: readonly string[] = Object.freeze([
  '0x4e59b44847b379578588920ca78fbf26c0b4956c',
  '0x1804c8ab1f12e6bbf3894d4083f33e07309d1f38',
  '0x7fa9385be102ac3eac297483dd6233d62b3e1496',
  '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
]);

/**
 * Every address up to this one is refused: the zero address and the precompile range (0x01, 0x02,
 * P256VERIFY at 0x0100, and room for future ones), as `uint160(a) <= 0x1ff` in Deploy.s.sol.
 */
export const MAX_RESERVED_ADDRESS = 0x1ffn;

const PUBLISHED: ReadonlySet<string> = new Set([
  ...PUBLISHED_MNEMONIC_ACCOUNTS,
  ...PUBLISHED_TOOLING_ADDRESSES,
]);

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * True for an address anyone can sign for or that no signer may be (any letter case). A string
 * that is not a 20-byte hex address counts as published too: the caller passed something no
 * signer can have, so it fails closed.
 */
export function isPublishedDevAddress(address: string): boolean {
  if (!EVM_ADDRESS.test(address)) return true;
  const lower = address.toLowerCase();
  return BigInt(lower) <= MAX_RESERVED_ADDRESS || PUBLISHED.has(lower);
}

/**
 * Startup check: refuses a published signer address unless every quoted chain is 31337. `what`
 * names the setting in the error ("the local signing key", "KMS_EXPECTED_SIGNER_ADDRESS"). The
 * address is public by definition, so naming it leaks nothing.
 */
export function assertNotPublishedSigner(
  address: string,
  quotedChainIds: readonly number[],
  what: string,
): void {
  if (!isPublishedDevAddress(address)) return;
  const offLocal = quotedChainIds.filter((id) => id !== PUBLISHED_SIGNER_CHAIN_ID);
  if (quotedChainIds.length > 0 && offLocal.length === 0) return;
  throw new Error(
    `${what} is ${address}, a published development address whose key is public (or an ` +
      `address no signer may be). Refusing to start: ZEROX_CHAIN_IDS includes chain(s) ` +
      `${offLocal.length > 0 ? offLocal.join(', ') : '(none)'} other than the local chain ` +
      `${PUBLISHED_SIGNER_CHAIN_ID}. Use a key of your own (production: a KMS key).`,
  );
}

/**
 * When the API must behave as a production deployment. Kept free of other imports so both the
 * config schema and the signer setup can use the one definition.
 */

/**
 * The only chains a key from the environment may ever sign for: known testnets and local
 * chains. `LOCAL_SIGNER_CHAIN_IDS` may narrow this set, never extend it.
 */
export const LOCAL_SIGNER_DEFAULT_CHAINS: readonly number[] = [
  84532, // Base Sepolia
  11155111, // Sepolia
  421614, // Arbitrum Sepolia
  31337, // Anvil / Hardhat (including a forked mainnet run under its own chain ID)
];

/**
 * True under NODE_ENV=production (trimmed, any case) or when any quoted chain is not a known
 * testnet or local chain. Unknown chains count as mainnets (fail closed). This is the trigger
 * for the KMS pin (`kmsPinRequired`) and for https-only WEB_ORIGINS.
 */
export function mainnetRulesApply(
  quotedChainIds: readonly number[],
  nodeEnv: string | undefined,
): boolean {
  if (nodeEnv?.trim().toLowerCase() === 'production') return true;
  return quotedChainIds.some((id) => !LOCAL_SIGNER_DEFAULT_CHAINS.includes(id));
}

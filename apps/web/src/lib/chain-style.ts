/**
 * Network colour per chain key, as full class names so Tailwind finds them. A chain the design has
 * no colour for gets the neutral fallback, never a guessed brand colour.
 */
export const CHAIN_BG: Readonly<Record<string, string>> = {
  'evm:1': 'bg-chain-ethereum',
  'evm:8453': 'bg-chain-base',
  'evm:42161': 'bg-chain-arbitrum',
  'solana:mainnet': 'bg-chain-solana',
};

export const CHAIN_BG_FALLBACK = 'bg-primary';

export function chainBg(key: string): string {
  return CHAIN_BG[key] ?? CHAIN_BG_FALLBACK;
}

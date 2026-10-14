import type { ComponentProps, ReactNode } from 'react';
import { getChain, type ChainConfig } from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import { chainBg } from '@/lib/chain-style';
import { defaultNetwork } from '@/lib/defaults';
import { t } from '@/lib/i18n';
import { Chevron } from './icons';

/** Coin colour and letter colour per network (letter colours chosen for 4.5:1 contrast). */
const COIN_LETTER: Record<string, string> = {
  'evm:1': 'text-ink',
  'evm:8453': 'text-on-primary',
  'evm:42161': 'text-ink',
  'solana:mainnet': 'text-on-primary',
};
const DOTS = ['fill-chain-ethereum', 'fill-chain-base', 'fill-chain-arbitrum', 'fill-chain-solana'];

/** 30 px round network coin: the chain's colour with its first letter. */
export function NetworkCoin({ chain }: { chain: ChainConfig }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-avatar items-center justify-center rounded-round text-caption font-bold ${chainBg(chain.key)} ${COIN_LETTER[chain.key] ?? 'text-on-primary'}`}
    >
      {chain.name.slice(0, 1)}
    </span>
  );
}

/** Shared look of the header's pill controls. */
export const PILL =
  'flex h-control items-center gap-8 rounded-pill text-body font-medium transition hover:brightness-95';
/** Neutral pills are `pill` on `ink`; the warning tone is the status tint with its text. */
export const PILL_TONE = {
  neutral: 'bg-pill text-ink',
  warning: 'bg-warning-tint text-warning-text',
} as const;

/**
 * The network pill's face: coin (or the four dots for "All networks"), name, chevron. Used as the
 * static pill when signed out and as the face of the network menu button when connected.
 */
export function NetworkPillFace({ network }: { network: ChainKey | 'all' }) {
  const chain = network === 'all' ? undefined : (getChain(network) ?? defaultNetwork());
  return (
    <>
      {chain ? (
        <NetworkCoin chain={chain} />
      ) : (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          {DOTS.map((fill, i) => (
            <circle
              key={fill}
              className={fill}
              cx={(i % 2) * 11 + 4.5}
              cy={Math.floor(i / 2) * 11 + 4.5}
              r="4.5"
            />
          ))}
        </svg>
      )}
      <span>{chain ? chain.name : t('header.network.all')}</span>
      <Chevron />
    </>
  );
}

export function networkName(network: ChainKey | 'all'): string {
  return network === 'all' ? t('header.network.all') : (getChain(network) ?? defaultNetwork()).name;
}

/** Pill-shaped button that carries a face and opts into the narrow-width rules. */
export function PillButton({
  tone = 'neutral',
  className = '',
  children,
  ...rest
}: ComponentProps<'button'> & { tone?: keyof typeof PILL_TONE; children: ReactNode }) {
  return (
    <button type="button" className={`${PILL} ${PILL_TONE[tone]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** Signed-out network pill: the default network, no menu (nothing to switch without a wallet). */
export function StaticNetworkPill({
  network,
  inMenu = false,
}: {
  network: ChainKey | 'all';
  inMenu?: boolean;
}) {
  return (
    <PillButton
      aria-label={t('header.network.label', { network: networkName(network) })}
      className={`pr-14 ${network === 'all' ? 'pl-8' : 'pl-7'} ${inMenu ? 'w-full narrow:hidden' : 'max-narrow:hidden'}`}
    >
      <NetworkPillFace network={network} />
    </PillButton>
  );
}

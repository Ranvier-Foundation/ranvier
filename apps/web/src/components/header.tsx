import Link from 'next/link';
import { getChain } from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import { defaultNetwork } from '@/lib/defaults';
import { shortAddress } from '@/lib/format';
import { t } from '@/lib/i18n';
import { Logo } from './logo';
import { MoreMenu } from './more-menu';
import { NavLink } from './nav-link';
import { NAV_ITEMS, ROUTES, type NavId } from './nav-items';

export interface HeaderProps {
  /** Active tab, or `none`. */
  active?: NavId | 'none';
  /** Connected wallet address; omit when signed out (shows the Connect wallet button). */
  wallet?: { address: string };
  /** Selected network, or `all`. Defaults to the first chain in the registry. */
  network?: ChainKey | 'all';
  /** Swaps in progress; the Activity badge is hidden at zero. */
  activityCount?: number;
}

/** Coin colour and letter colour per network (letter colours chosen for 4.5:1 contrast). */
const COIN: Record<string, string> = {
  'evm:1': 'bg-chain-ethereum text-ink',
  'evm:8453': 'bg-chain-base text-on-primary',
  'evm:42161': 'bg-chain-arbitrum text-ink',
  'solana:mainnet': 'bg-chain-solana text-on-primary',
};
const DOTS = ['fill-chain-ethereum', 'fill-chain-base', 'fill-chain-arbitrum', 'fill-chain-solana'];

function Chevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function NetworkPill({ network, inMenu = false }: { network: ChainKey | 'all'; inMenu?: boolean }) {
  const chain = network === 'all' ? undefined : (getChain(network) ?? defaultNetwork());
  const name = chain ? chain.name : t('header.network.all');
  return (
    <button
      type="button"
      aria-label={t('header.network.label', { network: name })}
      className={`flex h-control items-center gap-8 rounded-pill bg-pill pr-14 text-body font-medium text-ink transition hover:brightness-95 ${chain ? 'pl-7' : 'pl-8'} ${inMenu ? 'w-full narrow:hidden' : 'max-narrow:hidden'}`}
    >
      {chain ? (
        <span
          aria-hidden="true"
          className={`flex size-avatar items-center justify-center rounded-round text-caption font-bold ${COIN[chain.key] ?? 'bg-primary text-on-primary'}`}
        >
          {chain.name.slice(0, 1)}
        </span>
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
      <span>{name}</span>
      <Chevron />
    </button>
  );
}

function WalletPill({ address }: { address: string }) {
  const short = shortAddress(address);
  return (
    <button
      type="button"
      aria-label={t('header.wallet.label', { address: short })}
      className="flex h-control items-center gap-8 rounded-pill bg-pill pr-16 pl-7 text-body font-medium text-ink transition hover:brightness-95"
    >
      <span
        aria-hidden="true"
        className="grid size-avatar grid-cols-2 overflow-hidden rounded-round"
      >
        <span className="bg-primary" />
        <span className="bg-blush" />
        <span className="bg-blush" />
        <span className="bg-accent" />
      </span>
      <span className="addr">{short}</span>
    </button>
  );
}

export function Header({ active = 'swap', wallet, network, activityCount = 0 }: HeaderProps) {
  const selected = network ?? defaultNetwork().key;
  return (
    <header className="grid grid-cols-header items-center gap-20 px-20 py-16 text-body whitespace-nowrap max-narrow:gap-8 max-narrow:px-16">
      <div className="flex min-w-0 items-center">
        <Link
          href="/"
          aria-label={t('header.home.label')}
          className="flex h-control items-center text-ink no-underline"
        >
          <Logo size={32} />
        </Link>
      </div>
      <nav aria-label={t('header.nav.label')} className="flex items-center gap-4 max-nav:hidden">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            item={item}
            active={item.id === active}
            activityCount={activityCount}
            variant="pill"
          />
        ))}
      </nav>
      <div className="flex min-w-0 items-center justify-end gap-6">
        <NetworkPill network={selected} />
        {wallet ? (
          <WalletPill address={wallet.address} />
        ) : (
          <button
            type="button"
            className="flex h-control items-center rounded-pill bg-primary px-18 text-body font-medium text-on-primary outline-primary transition hover:opacity-88"
          >
            {t('header.connect')}
          </button>
        )}
        <Link
          href={ROUTES.notifications}
          aria-label={t('header.notifications')}
          className="flex size-control items-center justify-center rounded-round bg-pill text-ink transition hover:brightness-95 max-narrow:hidden"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="square"
            strokeLinejoin="miter"
            aria-hidden="true"
          >
            <path d="M6 17V10a6 6 0 0 1 12 0v7l2 2H4zM10 21h4" />
          </svg>
        </Link>
        <MoreMenu label={t('header.more')}>
          <nav aria-label={t('header.menu.label')} className="flex flex-col nav:hidden">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                active={item.id === active}
                activityCount={activityCount}
                variant="menu"
              />
            ))}
          </nav>
          <NetworkPill network={selected} inMenu />
          <Link
            href={ROUTES.notifications}
            className="flex h-control w-full items-center rounded-pill px-14 text-lead transition hover:bg-hover narrow:hidden"
          >
            {t('header.notifications')}
          </Link>
          <Link
            href={ROUTES.account}
            className="flex h-control w-full items-center rounded-pill px-14 text-lead transition hover:bg-hover"
          >
            {t('header.more.account')}
          </Link>
        </MoreMenu>
      </div>
    </header>
  );
}

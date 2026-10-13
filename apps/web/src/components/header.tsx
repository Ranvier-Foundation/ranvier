import Link from 'next/link';
import { t } from '@/lib/i18n';
import { Logo } from './logo';
import { MoreMenu } from './more-menu';
import { NetworkControl } from './network-control';
import { NavLink } from './nav-link';
import { NAV_ITEMS, ROUTES, type NavId } from './nav-items';
import { WalletControl } from './wallet-control';

export interface HeaderProps {
  /** Active tab, or `none`. */
  active?: NavId | 'none';
  /** Swaps in progress; the Activity badge is hidden at zero. */
  activityCount?: number;
}

export function Header({ active = 'swap', activityCount = 0 }: HeaderProps) {
  return (
    <header className="grid grid-cols-header items-center gap-20 px-20 py-16 text-body whitespace-nowrap max-narrow:gap-8">
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
      <div className="col-start-3 flex min-w-0 items-center justify-end gap-6">
        <NetworkControl variant="pill" />
        <WalletControl />
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
          <NetworkControl variant="list" />
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

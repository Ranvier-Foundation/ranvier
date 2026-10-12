import type { MessageId } from '@/lib/i18n';

export type NavId = 'swap' | 'trade' | 'buy' | 'activity' | 'portfolio';

/** Main navigation. Destinations other than Swap are screens that arrive in later changes. */
export const NAV_ITEMS: readonly { id: NavId; href: string; label: MessageId }[] = [
  { id: 'swap', href: '/', label: 'header.nav.swap' },
  { id: 'trade', href: '/trade', label: 'header.nav.trade' },
  { id: 'buy', href: '/buy', label: 'header.nav.buy' },
  { id: 'activity', href: '/activity', label: 'header.nav.activity' },
  { id: 'portfolio', href: '/portfolio', label: 'header.nav.portfolio' },
];

export const ROUTES = { notifications: '/activity', account: '/account' } as const;

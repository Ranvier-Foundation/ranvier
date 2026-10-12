import Link from 'next/link';
import { t, tPlural } from '@/lib/i18n';
import type { NAV_ITEMS } from './nav-items';

/** Activity badge: 18 px accent pill with the count, hidden at zero. */
export function ActivityBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="num inline-flex h-18 min-w-18 items-center justify-center rounded-pill bg-accent px-5 text-badge text-on-primary"
    >
      {count}
    </span>
  );
}

/** One nav entry, as a top-bar pill or a row in the more menu. */
export function NavLink({
  item,
  active,
  activityCount,
  variant,
}: {
  item: (typeof NAV_ITEMS)[number];
  active: boolean;
  activityCount: number;
  variant: 'pill' | 'menu';
}) {
  const hasBadge = item.id === 'activity' && activityCount > 0;
  const base =
    'flex h-control items-center gap-6 rounded-pill px-14 transition hover:bg-hover whitespace-nowrap';
  const shape = variant === 'pill' ? 'text-lead' : 'w-full text-lead';
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      aria-label={hasBadge ? tPlural('header.activity', activityCount) : undefined}
      className={`${base} ${shape} ${active ? 'bg-pill font-medium' : 'font-normal'}`}
    >
      {t(item.label)}
      {item.id === 'activity' ? <ActivityBadge count={activityCount} /> : null}
    </Link>
  );
}

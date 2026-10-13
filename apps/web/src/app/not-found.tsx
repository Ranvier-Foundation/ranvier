import Link from 'next/link';
import { Header } from '@/components/header';
import { t } from '@/lib/i18n';

/** Own 404 page: Next's default one carries inline styles, which the strict CSP forbids. */
export default function NotFound() {
  return (
    <>
      <Header active="none" />
      <main className="mx-auto flex max-w-panel flex-col items-start gap-16 px-20 pt-64 pb-160">
        <h1 className="text-h1 text-ink">{t('notfound.title')}</h1>
        <p className="text-lead text-sub">{t('notfound.body')}</p>
        <Link
          href="/"
          className="flex h-control items-center rounded-pill bg-primary px-24 text-lead font-medium text-on-primary no-underline outline-primary transition hover:opacity-88"
        >
          {t('notfound.back')}
        </Link>
      </main>
    </>
  );
}

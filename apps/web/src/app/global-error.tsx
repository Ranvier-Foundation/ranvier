'use client';

import { t } from '@/lib/i18n';
import '@fontsource-variable/inter/opsz.css';
import './globals.css';

/**
 * Last-resort error page. It replaces the root layout, so it renders its own html and body.
 * Styled with the same tokens and classes as the rest of the app: no inline style, no style
 * element (Next's default page has both, which a strict CSP forbids). A plain anchor is used
 * instead of next/link because the router may be the thing that failed.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const button =
    'flex h-control items-center rounded-pill px-24 text-lead font-medium no-underline transition';
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <main className="mx-auto flex max-w-panel flex-col items-start gap-16 px-20 pt-64 pb-160">
          <h1 className="text-h1 text-ink">{t('error.title')}</h1>
          <p className="text-lead text-sub">{t('error.body')}</p>
          <div className="flex flex-wrap gap-12">
            <button
              type="button"
              onClick={() => reset()}
              className={`${button} bg-primary text-on-primary outline-primary hover:opacity-88`}
            >
              {t('error.retry')}
            </button>
            <a href="/" className={`${button} border border-border-strong text-ink hover:bg-hover`}>
              {t('error.back')}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}

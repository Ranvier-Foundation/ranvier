import { Header } from '@/components/header';
import { SwapPanel } from '@/components/swap-panel';
import { t } from '@/lib/i18n';

export default function Home() {
  return (
    <>
      <Header active="swap" />
      <main className="px-20 pt-64 pb-160">
        <h1 className="sr-only">{t('swap.title')}</h1>
        <SwapPanel />
        <div className="mt-16 flex justify-center">
          <button
            type="button"
            className="flex h-56 w-cta items-center justify-center rounded-pill bg-primary text-lead font-medium text-on-primary outline-primary transition hover:opacity-88"
          >
            {t('swap.connect')}
          </button>
        </div>
      </main>
    </>
  );
}

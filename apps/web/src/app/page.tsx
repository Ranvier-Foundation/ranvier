import { Header } from '@/components/header';
import { SwapCta } from '@/components/swap-cta';
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
          <SwapCta />
        </div>
      </main>
    </>
  );
}

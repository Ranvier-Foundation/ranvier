import { Header } from '@/components/header';
import { SwapScreen } from '@/components/swap-screen';
import { t } from '@/lib/i18n';

export default function Home() {
  return (
    <>
      <Header active="swap" />
      <main className="px-20 pt-64 pb-160">
        <h1 className="sr-only">{t('swap.title')}</h1>
        <SwapScreen />
      </main>
    </>
  );
}

import type { Metadata } from 'next';
import { Header } from '@/components/header';
import { SelectTokenScreen } from '@/components/select-token-screen';
import { SwapPanel } from '@/components/swap-panel';
import { t } from '@/lib/i18n';

export const metadata: Metadata = { title: t('picker.meta.title') };

/**
 * Select token (canvas: WebTokenSelect, MobileTokenSelect): the picker opens over the swap screen,
 * as on the artboards, where it sits on the swap panel behind the scrim.
 */
export default function SelectTokenPage() {
  return (
    <>
      <Header active="swap" />
      <main className="px-20 pt-64 pb-160">
        <h1 className="sr-only">{t('swap.title')}</h1>
        <SwapPanel />
        <SelectTokenScreen />
      </main>
    </>
  );
}

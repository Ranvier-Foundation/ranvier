'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getChain, listTokens } from '@ranvier/chains';
import type { TokenRef } from '@ranvier/types';
import { shortAddress } from '@/lib/format';
import { t } from '@/lib/i18n';
import { TokenPicker } from './token-picker';

/** Names a chosen token for the confirmation line, from the checked-in registry and list. */
function describe(ref: TokenRef): { token: string; chain: string } {
  const listed = listTokens(ref.chain).find((tok) => tok.address === ref.address);
  return {
    token:
      listed?.symbol ?? t('picker.screen.selected.unknown', { address: shortAddress(ref.address) }),
    chain: getChain(ref.chain)?.name ?? ref.chain,
  };
}

/**
 * The picker's screen: opens at once over the swap panel. Closing without a choice goes back to
 * the swap screen. A choice closes the picker and is shown; the swap screen does not take a chosen
 * token yet, and the screen says so instead of pretending.
 */
export function SelectTokenScreen() {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<TokenRef | null>(null);
  const result = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) result.current?.focus();
  }, [selected]);

  const close = () => {
    if (selected) setOpen(false);
    else router.push('/');
  };

  return (
    <>
      {open ? (
        <TokenPicker
          onClose={close}
          onSelect={(token) => {
            setSelected(token);
            setOpen(false);
          }}
        />
      ) : null}
      {selected ? (
        <section className="mx-auto mt-16 max-w-panel bg-surface px-24 py-24">
          <div ref={result} tabIndex={-1} className="outline-none">
            <h2 className="m-0 text-lead font-semibold">{t('picker.screen.selected.title')}</h2>
            <p className="m-0 mt-4 text-small text-sub">
              {t('picker.screen.selected.body', describe(selected))}
            </p>
            <p className="m-0 mt-4 text-small text-sub">{t('picker.screen.selected.note')}</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-16 flex h-control items-center rounded-pill bg-primary px-18 text-body font-medium text-on-primary outline-primary transition hover:opacity-88"
          >
            {t('picker.screen.open')}
          </button>
        </section>
      ) : null}
    </>
  );
}

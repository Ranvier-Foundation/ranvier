'use client';

import { useEffect, useRef, useState } from 'react';
import { useConnection, useDisconnect } from 'wagmi';
import { shortAddress } from '@/lib/format';
import { t } from '@/lib/i18n';
import { explorerAddressUrl, registryChainByWalletId } from '@/lib/wallet/chains';
import { useDisclosure } from '@/lib/use-disclosure';
import { ConnectWalletButton } from './connect-button';
import { WALLET_PILL_ID } from './connect-dialog';
import { PILL, PILL_TONE } from './network-pill';
import { WalletAvatar } from './wallet-avatar';

type CopyState = 'idle' | 'copied' | 'failed';

const ITEM =
  'flex h-control w-full items-center rounded-pill px-14 text-lead transition hover:bg-hover';

function WalletMenuPanel({ address, onDone }: { address: string; onDone: () => void }) {
  const { chainId } = useConnection();
  const { disconnect } = useDisconnect();
  const [copy, setCopy] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const chain = registryChainByWalletId(chainId);

  async function copyAddress() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(address);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
    timer.current = setTimeout(() => setCopy('idle'), 2500);
  }

  return (
    <>
      <p className="m-0 px-14 pt-8 pb-4 text-caption text-sub">{t('header.wallet.menu.heading')}</p>
      <p className="addr m-0 px-14 pb-8 text-small break-all">{address}</p>
      <button type="button" onClick={() => void copyAddress()} className={ITEM}>
        {t('header.wallet.copy')}
      </button>
      <p role="status" className="m-0 px-14 text-caption text-sub empty:hidden">
        {copy === 'copied' ? t('header.wallet.copied') : null}
      </p>
      <p role="alert" className="m-0 px-14 pb-4 text-caption text-danger-text empty:hidden">
        {copy === 'failed' ? t('header.wallet.copy.failed') : null}
      </p>
      {chain ? (
        <a
          href={explorerAddressUrl(chain, address)}
          target="_blank"
          rel="noopener noreferrer"
          className={ITEM}
        >
          {t('header.wallet.explorer')}
          <span className="sr-only"> ({t('header.wallet.explorer.newtab')})</span>
        </a>
      ) : null}
      <button
        type="button"
        onClick={() => {
          onDone();
          disconnect();
        }}
        className={ITEM}
      >
        {t('header.wallet.disconnect')}
      </button>
    </>
  );
}

/**
 * The wallet area of the header: Connect wallet when signed out, a disabled "Connecting" pill
 * while wagmi restores a saved connection, and the wallet pill (avatar, short address, `+N` for
 * other authorised accounts) with its menu when connected.
 */
export function WalletControl() {
  const { status, address, addresses } = useConnection();
  const { open, setOpen, panelId, root, button } = useDisclosure();
  useEffect(() => {
    if (!address) setOpen(false);
  }, [address, setOpen]);

  if (status === 'connecting' || status === 'reconnecting') {
    return (
      <button
        type="button"
        disabled
        className={`${PILL} ${PILL_TONE.neutral} cursor-not-allowed px-18 opacity-50`}
      >
        {t('header.wallet.connecting')}
      </button>
    );
  }
  if (status !== 'connected' || !address) {
    return (
      <ConnectWalletButton className="flex h-control items-center rounded-pill bg-primary px-18 text-body font-medium text-on-primary outline-primary transition hover:opacity-88">
        {t('header.connect')}
      </ConnectWalletButton>
    );
  }

  const short = shortAddress(address);
  const others = Math.max(0, (addresses?.length ?? 1) - 1);
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        id={WALLET_PILL_ID}
        type="button"
        aria-label={
          others > 0
            ? t('header.wallet.label.more', { address: short, count: others })
            : t('header.wallet.label', { address: short })
        }
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={`${PILL} ${PILL_TONE.neutral} pr-16 pl-7`}
      >
        <WalletAvatar address={address} />
        <span className="addr">{short}</span>
        {others > 0 ? (
          <span className="rounded-pill bg-surface px-7 py-2 text-tag font-normal text-sub max-narrow:hidden">
            +{others}
          </span>
        ) : null}
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute top-full right-0 z-10 mt-6 w-menu border border-line bg-surface p-6"
      >
        {open ? <WalletMenuPanel address={address} onDone={() => setOpen(false)} /> : null}
      </div>
    </div>
  );
}

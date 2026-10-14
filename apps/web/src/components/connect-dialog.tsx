'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useConnect, useConnection, useConnectors, type Connector } from 'wagmi';
import { shortAddress } from '@/lib/format';
import { t } from '@/lib/i18n';
import { classifyWalletError } from '@/lib/wallet/errors';
import { listWallets, type WalletOption as Option } from '@/lib/wallet/wallets';

type WalletOption = Option<Connector>;
import { Modal } from './modal';

interface ConnectDialogApi {
  open: () => void;
}
const ConnectDialogContext = createContext<ConnectDialogApi | null>(null);

/** Opens the connect dialog from any button. */
export function useConnectDialog(): ConnectDialogApi {
  const api = useContext(ConnectDialogContext);
  if (!api) throw new Error('useConnectDialog needs ConnectDialogProvider');
  return api;
}

/** Id of the wallet pill, where focus lands when the trigger vanished because a wallet connected. */
export const WALLET_PILL_ID = 'wallet-pill';

export function ConnectDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);

  const open = useCallback(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);
  const api = useMemo(() => ({ open }), [open]);

  const close = useCallback(() => {
    setOpen(false);
    // Wait for the dialog to unmount and the header to re-render, then return focus.
    requestAnimationFrame(() => {
      const target =
        trigger.current?.isConnected === true
          ? trigger.current
          : document.getElementById(WALLET_PILL_ID);
      target?.focus();
    });
  }, []);

  return (
    <ConnectDialogContext.Provider value={api}>
      {children}
      {isOpen ? <ConnectDialog onClose={close} /> : null}
    </ConnectDialogContext.Provider>
  );
}

type Attempt =
  | { kind: 'idle' }
  | { kind: 'connecting'; wallet: WalletOption }
  | { kind: 'failed'; wallet: WalletOption; reason: 'rejected' | 'pending' | 'other' };

const ROW =
  'flex min-h-56 w-full items-center gap-12 px-12 text-left text-body transition hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

function WalletIcon({ icon, name }: { icon?: string | undefined; name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-36 shrink-0 items-center justify-center overflow-hidden rounded-icon bg-pill text-small font-bold text-ink"
    >
      {icon ? (
        // Provider-supplied icons were checked to be small base64 data images; <img> only.
        <img src={icon} alt="" width={36} height={36} className="size-36 object-contain" />
      ) : (
        Array.from(name)[0]?.toUpperCase()
      )}
    </span>
  );
}

function SoonRow({ name }: { name: string }) {
  return (
    <li>
      <button type="button" disabled className={ROW}>
        <WalletIcon name={name} />
        <span className="flex-1 font-medium">{name}</span>
        <span className="text-tag text-sub">{t('wallet.dialog.soon')}</span>
      </button>
    </li>
  );
}

function Column({
  heading,
  divided = false,
  children,
}: {
  heading: string;
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={heading}
      className={`px-12 max-narrow:py-8 ${divided ? 'border-line narrow:border-l max-narrow:border-t' : ''}`}
    >
      <h2 className="m-0 mb-8 text-caption font-medium text-sub">{heading}</h2>
      <ul className="m-0 -mx-12 list-none p-0">{children}</ul>
    </section>
  );
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const { connectAsync } = useConnect();
  const { status, address } = useConnection();
  const connectors = useConnectors();
  const wallets = useMemo(() => listWallets(connectors), [connectors]);
  const [attempt, setAttempt] = useState<Attempt>({ kind: 'idle' });
  const connected = status === 'connected' && address !== undefined;
  const wasConnected = useRef(connected);

  // A wallet connected while the dialog was open (this one or another tab): done.
  useEffect(() => {
    if (connected && !wasConnected.current) onClose();
    wasConnected.current = connected;
  }, [connected, onClose]);

  async function pick(wallet: WalletOption) {
    setAttempt({ kind: 'connecting', wallet });
    try {
      await connectAsync({ connector: wallet.connector });
      setAttempt({ kind: 'idle' });
    } catch (error) {
      setAttempt({ kind: 'failed', wallet, reason: classifyWalletError(error) });
    }
  }

  const connecting = attempt.kind === 'connecting';
  const failed = attempt.kind === 'failed' ? attempt : undefined;

  return (
    <Modal
      titleId="connect-title"
      title={t('wallet.dialog.title')}
      closeLabel={t('wallet.dialog.close')}
      onClose={onClose}
      restoreFocus={false}
    >
      {connected ? (
        <div className="px-24 py-24">
          <p className="m-0 text-lead font-semibold">{t('wallet.connected.title')}</p>
          <p className="m-0 mt-4 text-small text-sub">
            <span className="addr">
              {t('wallet.connected.body', { address: shortAddress(address) })}
            </span>
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-16 flex h-control items-center rounded-pill bg-primary px-18 text-body font-medium text-on-primary outline-primary transition hover:opacity-88"
          >
            {t('wallet.connected.done')}
          </button>
        </div>
      ) : (
        <>
          <p className="m-0 px-24 pt-16 text-small leading-body text-sub">
            {t('wallet.dialog.intro')}
          </p>
          <div className="grid grid-cols-2 px-12 pt-16 pb-8 max-narrow:grid-cols-1">
            <Column heading={t('wallet.dialog.evm')}>
              {wallets.map((wallet) => (
                <li key={wallet.key}>
                  <button
                    type="button"
                    disabled={connecting}
                    aria-busy={attempt.kind === 'connecting' && attempt.wallet.key === wallet.key}
                    onClick={() => void pick(wallet)}
                    className={ROW}
                  >
                    <WalletIcon icon={wallet.icon} name={wallet.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{wallet.name}</span>
                      {wallet.hint ? (
                        <span className="block truncate text-tag text-sub">{wallet.hint}</span>
                      ) : null}
                    </span>
                    <span className="text-tag text-sub">
                      {attempt.kind === 'connecting' && attempt.wallet.key === wallet.key
                        ? t('wallet.dialog.connecting.tag')
                        : t('wallet.dialog.detected')}
                    </span>
                  </button>
                </li>
              ))}
              <SoonRow name={t('wallet.dialog.phone')} />
            </Column>
            <Column heading={t('wallet.dialog.solana')} divided>
              <SoonRow name={t('wallet.dialog.solana.name')} />
            </Column>
          </div>

          {wallets.length === 0 ? (
            <div className="mx-24 mb-8 border-t border-line py-16">
              <p className="m-0 text-lead font-semibold">{t('wallet.dialog.empty.title')}</p>
              <p className="m-0 mt-4 text-small leading-body text-sub">
                {t('wallet.dialog.empty.body')}
              </p>
            </div>
          ) : null}

          <div className="px-24 empty:hidden">
            <p role="status" className="m-0 pb-8 text-small leading-body text-sub empty:hidden">
              {attempt.kind === 'connecting'
                ? t('wallet.connecting', { wallet: attempt.wallet.name })
                : null}
            </p>
            {failed ? (
              <div role="alert" className="mb-8 bg-danger-tint p-12 text-danger-text">
                <p className="m-0 text-small leading-body">
                  {failed.reason === 'rejected'
                    ? t('wallet.rejected', { wallet: failed.wallet.name })
                    : failed.reason === 'pending'
                      ? t('wallet.pending', { wallet: failed.wallet.name })
                      : t('wallet.error', { wallet: failed.wallet.name })}
                </p>
                <button
                  type="button"
                  onClick={() => void pick(failed.wallet)}
                  className="mt-8 flex h-control items-center rounded-pill border border-danger-text px-18 text-body font-medium transition hover:bg-hover"
                >
                  {t('wallet.retry')}
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
      <p className="m-0 bg-bg px-24 pt-14 pb-20 text-caption text-sub">
        {t('wallet.dialog.footer')}
      </p>
    </Modal>
  );
}

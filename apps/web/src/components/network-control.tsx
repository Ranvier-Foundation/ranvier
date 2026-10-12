'use client';

import { useEffect, useState } from 'react';
import { useConnection, useSwitchChain } from 'wagmi';
import type { ChainConfig } from '@ranvier/chains';
import { defaultNetwork } from '@/lib/defaults';
import { t } from '@/lib/i18n';
import { classifyWalletError } from '@/lib/wallet/errors';
import { EVM_CHAINS, evmChainId, registryChainByWalletId } from '@/lib/wallet/chains';
import { useDisclosure } from '@/lib/use-disclosure';
import { Chevron } from './icons';
import { NetworkCoin, NetworkPillFace, PillButton, StaticNetworkPill } from './network-pill';

type SwitchState =
  | { kind: 'idle' }
  | { kind: 'switching'; chain: ChainConfig }
  | { kind: 'failed'; chain: ChainConfig; reason: 'rejected' | 'pending' | 'other' };

const ROW =
  'flex h-control w-full items-center gap-8 rounded-pill px-14 text-lead transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

/** The chain list (and the unsupported-network notice) shown in the menu and the more menu. */
function NetworkChoices({
  active,
  onDone,
}: {
  active: ChainConfig | undefined;
  onDone?: () => void;
}) {
  const { switchChainAsync } = useSwitchChain();
  const [state, setState] = useState<SwitchState>({ kind: 'idle' });
  const busy = state.kind === 'switching';
  const fallback = defaultNetwork();

  async function switchTo(chain: ChainConfig) {
    const chainId = evmChainId(chain);
    if (chainId === undefined || busy) return;
    setState({ kind: 'switching', chain });
    try {
      await switchChainAsync({ chainId });
      setState({ kind: 'idle' });
      onDone?.();
    } catch (error) {
      setState({ kind: 'failed', chain, reason: classifyWalletError(error) });
    }
  }

  return (
    <div role="group" aria-label={t('header.network.menu.heading')} className="flex flex-col gap-2">
      {active ? null : (
        <div className="mb-6 flex flex-col gap-8 bg-warning-tint p-12 text-warning-text">
          <p className="m-0 text-caption leading-body">{t('header.network.unsupported.body')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void switchTo(fallback)}
            className="flex h-control items-center justify-center rounded-pill bg-primary px-18 text-body font-medium text-on-primary outline-primary transition hover:opacity-88 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('header.network.switch.to', { network: fallback.name })}
          </button>
        </div>
      )}
      {EVM_CHAINS.map((chain) => {
        const current = active?.key === chain.key;
        return (
          <button
            key={chain.key}
            type="button"
            disabled={busy}
            aria-current={current ? 'true' : undefined}
            onClick={() => void (current ? onDone?.() : switchTo(chain))}
            className={ROW}
          >
            <NetworkCoin chain={chain} />
            <span className="flex-1 text-left font-medium">{chain.name}</span>
            {current ? (
              <span className="text-caption text-sub">{t('header.network.current')}</span>
            ) : null}
          </button>
        );
      })}
      <p role="status" className="m-0 px-14 text-caption leading-body text-sub empty:hidden">
        {state.kind === 'switching'
          ? t('header.network.switching', { network: state.chain.name })
          : null}
      </p>
      <p role="alert" className="m-0 px-14 text-caption leading-body text-danger-text empty:hidden">
        {state.kind === 'failed'
          ? state.reason === 'rejected'
            ? t('header.network.rejected')
            : state.reason === 'pending'
              ? t('header.network.pending')
              : t('header.network.error', { network: state.chain.name })
          : null}
      </p>
    </div>
  );
}

/**
 * Network control. Signed out: the default network, as a plain pill. Connected: the wallet's
 * current chain with a menu to switch; a chain Ranvier does not list shows "Unsupported network"
 * (never silently the default). `variant="list"` is the same choices inline, for the more menu
 * below 640 px, where the pill itself is hidden.
 */
export function NetworkControl({ variant }: { variant: 'pill' | 'list' }) {
  const { status, chainId } = useConnection();
  const { open, setOpen, panelId, root, button } = useDisclosure();
  // Close the menu if the wallet disconnects while it is open.
  useEffect(() => {
    if (status !== 'connected') setOpen(false);
  }, [status, setOpen]);

  if (status !== 'connected') {
    return <StaticNetworkPill network={defaultNetwork().key} inMenu={variant === 'list'} />;
  }
  const active = registryChainByWalletId(chainId);

  if (variant === 'list') {
    return (
      <div className="w-full narrow:hidden">
        <NetworkChoices active={active} />
      </div>
    );
  }
  return (
    <div ref={root} className="relative max-narrow:hidden">
      <PillButton
        ref={button}
        aria-label={
          active
            ? t('header.network.label', { network: active.name })
            : t('header.network.unsupported.label')
        }
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        tone={active ? 'neutral' : 'warning'}
        className="pr-14 pl-7"
      >
        {active ? (
          <NetworkPillFace network={active.key} />
        ) : (
          <>
            <span
              aria-hidden="true"
              className="flex size-avatar items-center justify-center rounded-round bg-warning-text text-caption font-bold text-warning-tint"
            >
              !
            </span>
            <span>{t('header.network.unsupported')}</span>
            <Chevron />
          </>
        )}
      </PillButton>
      <div
        id={panelId}
        hidden={!open}
        className="absolute top-full right-0 z-10 mt-6 w-menu border border-line bg-surface p-6"
      >
        {open ? <NetworkChoices active={active} onDone={() => setOpen(false)} /> : null}
      </div>
    </div>
  );
}

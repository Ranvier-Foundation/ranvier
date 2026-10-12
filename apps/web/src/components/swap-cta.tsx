'use client';

import { useConnection } from 'wagmi';
import { t } from '@/lib/i18n';
import { ConnectWalletButton } from './connect-button';

const CTA =
  'flex h-56 w-cta items-center justify-center rounded-pill bg-primary text-lead font-medium text-on-primary outline-primary transition';

/**
 * The swap screen's primary button. Signed out it opens the connect dialog. Connected it reads
 * "Enter an amount" and stays disabled: amounts and quotes come in a later change.
 */
export function SwapCta() {
  const { status } = useConnection();
  if (status === 'connected') {
    return (
      <button type="button" disabled className={`${CTA} cursor-not-allowed opacity-50`}>
        {t('swap.enter')}
      </button>
    );
  }
  return (
    <ConnectWalletButton className={`${CTA} hover:opacity-88`}>
      {t('swap.connect')}
    </ConnectWalletButton>
  );
}

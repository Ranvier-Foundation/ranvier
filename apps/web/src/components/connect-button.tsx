'use client';

import type { ReactNode } from 'react';
import { useConnectDialog } from './connect-dialog';

/** A button that opens the connect dialog; the header and the swap screen style it differently. */
export function ConnectWalletButton({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const { open } = useConnectDialog();
  return (
    <button type="button" onClick={open} className={className}>
      {children}
    </button>
  );
}

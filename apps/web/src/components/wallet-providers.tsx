'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { createWalletConfig } from '@/lib/wallet/config';
import { ConnectDialogProvider } from './connect-dialog';

/** wagmi, its query cache and the connect dialog, mounted once in the root layout. */
export function WalletProviders({ children }: { children: ReactNode }) {
  const [config] = useState(createWalletConfig);
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectDialogProvider>{children}</ConnectDialogProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

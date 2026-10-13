import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { connection } from 'next/server';
import { WalletProviders } from '@/components/wallet-providers';
import { t } from '@/lib/i18n';
import '@fontsource-variable/inter/opsz.css';
import './globals.css';

export const metadata: Metadata = {
  title: t('meta.title'),
  description: t('meta.description'),
};

/**
 * Every route renders per request (ADR 0008): the strict CSP's nonce is new on each request, and
 * Next can only put it on the scripts of a page rendered for that request. A prerendered page
 * would carry no nonce and the browser would refuse all of its scripts.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { t } from '@/lib/i18n';
import '@fontsource-variable/inter/opsz.css';
import './globals.css';

export const metadata: Metadata = {
  title: t('meta.title'),
  description: t('meta.description'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}

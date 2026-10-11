import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Header } from '@/components/header';
import '@fontsource-variable/inter';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ranvier',
  description: 'Best-price token swaps across chains, with safety checks before you sign.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <Header />
        {children}
      </body>
    </html>
  );
}

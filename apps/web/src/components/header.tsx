import Link from 'next/link';
import { Logo } from './logo';

const NAV = ['Swap', 'Trade', 'Buy', 'Activity', 'Portfolio'] as const;

export function Header() {
  return (
    <header className="flex items-center gap-6 px-5 py-4">
      <div className="flex flex-1 items-center">
        <Link href="/" aria-label="Ranvier home" className="text-ink no-underline">
          <Logo />
        </Link>
      </div>
      <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
        {NAV.map((label) => (
          <Link
            key={label}
            href="/"
            aria-current={label === 'Swap' ? 'page' : undefined}
            className="flex h-11 items-center rounded-full px-4 text-base aria-[current=page]:bg-chip aria-[current=page]:font-medium"
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-1 justify-end">
        <button
          type="button"
          className="h-11 rounded-full bg-brand-deep px-[18px] text-[15px] font-medium text-white"
        >
          Connect wallet
        </button>
      </div>
    </header>
  );
}

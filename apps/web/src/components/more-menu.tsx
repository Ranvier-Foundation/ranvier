'use client';

import type { ReactNode } from 'react';
import { useDisclosure } from '@/lib/use-disclosure';

/**
 * The "more" control: a disclosure button that opens a panel of links. Below 1200 px the panel
 * also carries the main navigation (the header passes it as `children`; the nav-only rows hide
 * themselves at wider widths with CSS). Escape and an outside click close it and focus returns
 * to the button.
 */
export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
  const { open, setOpen, panelId, root, button } = useDisclosure();

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex size-control items-center justify-center rounded-round bg-pill text-ink transition hover:brightness-95"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {[4, 10, 16].flatMap((y) =>
            [4, 10, 16].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" />),
          )}
        </svg>
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute top-full right-0 z-10 mt-6 w-menu border border-line bg-surface p-6"
      >
        {children}
      </div>
    </div>
  );
}

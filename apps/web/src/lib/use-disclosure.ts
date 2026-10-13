'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * Open state for a button that shows a panel: Escape and an outside click close it, and Escape
 * returns focus to the button. Shared by the more menu, the wallet menu and the network menu.
 */
export function useDisclosure() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return { open, setOpen, panelId, root, button };
}

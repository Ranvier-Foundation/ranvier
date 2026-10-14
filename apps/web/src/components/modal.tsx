'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './icons';

/**
 * The two modal looks. `standard` is the Connect wallet dialog (a ruled header, up to 640 px, 96 px
 * from the top, a sheet as tall as its content on mobile). `picker` is Select token (a plain
 * header, up to 560 px, 72 px from the top, a full-height sheet on mobile whose body scrolls inside).
 */
const LOOKS = {
  standard: {
    frame: 'px-20 pt-96 pb-40 max-narrow:px-0 max-narrow:pt-56 max-narrow:pb-0',
    panel: 'max-w-panel max-narrow:mt-auto',
    header: 'border-b border-line px-24 py-22',
    title: 'text-title-s',
  },
  picker: {
    frame: 'px-20 pt-72 pb-40 max-narrow:px-0 max-narrow:pt-56 max-narrow:pb-0',
    panel: 'max-w-picker min-h-0 max-h-full flex flex-col max-narrow:h-full',
    header: 'shrink-0 px-24 pt-20 pb-12 max-narrow:py-8 max-narrow:pr-16 max-narrow:pl-20',
    title: 'text-title-s max-narrow:text-title-s-mobile',
  },
} as const;

export type ModalVariant = keyof typeof LOOKS;

const TABBABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  variant?: ModalVariant;
  /** Id of the title element, which labels the dialog. */
  titleId: string;
  title: string;
  closeLabel: string;
  onClose: () => void;
  /**
   * Return focus to the element that had it when the modal opened. Off for the connect dialog,
   * whose provider decides (the opener may be replaced once a wallet connects).
   */
  restoreFocus?: boolean;
  /** Focus the element marked `data-initial-focus` instead of the first control (pointer devices only). */
  focusMarked?: boolean;
  children: ReactNode;
}

/**
 * Native modal `dialog`: top layer and inert page come from the browser, plus a Tab wrap, Escape
 * and scrim click to close, and focus back to the opener. Below 640 px it is a bottom sheet with a
 * grab handle (docs/ui-guidelines.md, Modal).
 */
export function Modal({
  variant = 'standard',
  titleId,
  title,
  closeLabel,
  onClose,
  restoreFocus = true,
  focusMarked = false,
  children,
}: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const look = LOOKS[variant];

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    // On a touch screen focusing a text field opens the keyboard over the sheet: leave focus on
    // the first control there.
    if (focusMarked && window.matchMedia('(pointer: fine)').matches) {
      el.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    }
    return () => {
      el.close();
      if (restoreFocus && opener) {
        // After the dialog is gone and the page behind it is live again.
        requestAnimationFrame(() => {
          if (opener.isConnected) opener.focus();
        });
      }
    };
  }, [focusMarked, restoreFocus]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        // Keep Tab inside the dialog: wrap from the last control to the first and back.
        if (e.key !== 'Tab') return;
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE));
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onClick={(e) => {
        // A click on the scrim (the dialog element itself or its padding frame) closes.
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset['scrim'] === 'true') {
          onClose();
        }
      }}
      className="m-0 size-full max-h-full max-w-full overflow-hidden bg-transparent p-0 text-ink backdrop:bg-scrim"
    >
      <div
        data-scrim="true"
        className={`flex h-full flex-col ${variant === 'picker' ? '' : 'overflow-y-auto'} ${look.frame}`}
      >
        <div className={`mx-auto w-full bg-surface ${look.panel}`}>
          <span
            aria-hidden="true"
            className="mx-auto mt-10 block h-4 w-40 shrink-0 rounded-pill bg-border-strong narrow:hidden"
          />
          <div className={`flex items-center justify-between ${look.header}`}>
            <h1 id={titleId} className={`m-0 ${look.title}`}>
              {title}
            </h1>
            <button
              type="button"
              aria-label={closeLabel}
              onClick={onClose}
              className="flex size-control shrink-0 items-center justify-center rounded-round transition hover:bg-hover-row"
            >
              <CloseIcon />
            </button>
          </div>
          {children}
        </div>
      </div>
    </dialog>
  );
}

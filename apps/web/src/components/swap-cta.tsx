'use client';

import { t } from '@/lib/i18n';
import { ctaLabelId } from '@/lib/swap/copy';
import type { CtaState } from '@/lib/swap/model';
import { ConnectWalletButton } from './connect-button';

const CTA =
  'flex h-56 w-cta items-center justify-center rounded-pill text-lead font-medium outline-primary transition';
/** In progress or waiting for input: the primary pill, dimmed (docs/ui-guidelines.md, Disabled). */
const WAITING = `${CTA} cursor-not-allowed bg-primary text-on-primary opacity-50`;
/** Blocked or failed: the canvas's "Insufficient balance" pill (`pill` fill, muted text). */
const BLOCKED = `${CTA} cursor-not-allowed bg-pill text-deep-muted2`;

export interface SwapCtaProps {
  state: CtaState;
  /** Id of the note under the button, which explains why it says what it says. */
  describedBy?: string;
  /** "Get a new quote" (an expired quote the screen stopped replacing by itself). */
  onRefresh: () => void;
}

/**
 * The swap screen's primary button (264 x 56 px, centred 16 px under the panel). It says what is
 * missing or wrong in plain words; only two states can be pressed: connect, and a new quote.
 * `review` is a fresh quote on screen: the review step does not exist yet, so the button is
 * disabled and the note under it says so (ADR 0011).
 */
export function SwapCta({ state, describedBy, onRefresh }: SwapCtaProps) {
  const label = t(ctaLabelId(state));
  if (state.kind === 'connect') {
    return (
      <ConnectWalletButton className={`${CTA} bg-primary text-on-primary hover:opacity-88`}>
        {label}
      </ConnectWalletButton>
    );
  }
  if (state.kind === 'expired') {
    return (
      <button
        type="button"
        onClick={onRefresh}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        className={`${CTA} bg-primary text-on-primary hover:opacity-88`}
      >
        {label}
      </button>
    );
  }
  const blocked =
    state.kind === 'unsupported-pair' ||
    state.kind === 'amount-too-large' ||
    state.kind === 'insufficient-balance' ||
    state.kind === 'error';
  return (
    <button
      type="button"
      disabled
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      className={blocked ? BLOCKED : WAITING}
    >
      {label}
    </button>
  );
}

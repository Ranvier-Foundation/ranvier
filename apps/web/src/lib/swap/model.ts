import type { QuoteAsk } from '@/lib/api/quote';
import type { ChainsState } from '@/lib/picker/use-token-picker';
import type { AmountParse } from './amount';
import type { SwapToken } from './tokens';
import type { QuoteErrorKind, QuoteState } from './use-quote';
import { AUTO_SLIPPAGE_BPS } from './config';

/**
 * What the swap button says and does, decided in one pure function so every state is testable
 * (docs/ui-guidelines.md section 6). Balances never decide whether a quote is asked for (they are
 * display data, ADR 0009, ADR 0011); `insufficient` only changes what the button says.
 */

export type PairSupport =
  | { ok: true }
  | { ok: false; reason: 'loading' }
  /** Pay and receive tokens are on different chains: the API routes one chain at a time. */
  | { ok: false; reason: 'cross-chain' }
  /** The API says it cannot quote on this chain right now (`quoting: false`). */
  | { ok: false; reason: 'chain-unavailable' };

/**
 * Whether the pair can be quoted, from the tokens and the API's chain list. If the chain list
 * could not be read the pair is tried anyway: the quote answer says what is wrong.
 */
export function pairSupport(pay: SwapToken, receive: SwapToken, chains: ChainsState): PairSupport {
  if (pay.ref.chain !== receive.ref.chain) return { ok: false, reason: 'cross-chain' };
  if (chains.status === 'loading') return { ok: false, reason: 'loading' };
  if (chains.status === 'ready') {
    const entry = chains.chains.find((c) => c.key === pay.ref.chain);
    if (!entry?.quoting) return { ok: false, reason: 'chain-unavailable' };
  }
  return { ok: true };
}

export type CtaState =
  | { kind: 'connect' }
  | { kind: 'select-token' }
  | { kind: 'unsupported-pair'; reason: 'cross-chain' | 'chain-unavailable' }
  | { kind: 'enter-amount' }
  | { kind: 'amount-too-large' }
  | { kind: 'insufficient-balance' }
  | { kind: 'fetching'; after: 'change' | 'expiry' }
  | { kind: 'error'; error: QuoteErrorKind }
  | { kind: 'expired' }
  /** A fresh quote is on screen. The review step is not built, so this button does nothing yet. */
  | { kind: 'review' };

export interface CtaInput {
  connected: boolean;
  pay: SwapToken | null;
  receive: SwapToken | null;
  pair: PairSupport | undefined;
  amount: AmountParse;
  /** The last balance read is below the amount. Display only. */
  insufficient: boolean;
  quote: QuoteState;
}

export function ctaState(i: CtaInput): CtaState {
  if (!i.connected) return { kind: 'connect' };
  if (i.pay === null || i.receive === null) return { kind: 'select-token' };
  if (i.pair && !i.pair.ok && i.pair.reason !== 'loading') {
    return { kind: 'unsupported-pair', reason: i.pair.reason };
  }
  if (i.amount.kind === 'too_large') return { kind: 'amount-too-large' };
  if (i.amount.kind !== 'ok') return { kind: 'enter-amount' };
  if (i.insufficient) return { kind: 'insufficient-balance' };
  if (i.pair && !i.pair.ok) return { kind: 'fetching', after: 'change' };
  switch (i.quote.status) {
    case 'idle':
      return { kind: 'fetching', after: 'change' };
    case 'loading':
      return { kind: 'fetching', after: i.quote.after };
    case 'error':
      return { kind: 'error', error: i.quote.kind };
    case 'expired':
      return { kind: 'expired' };
    case 'ready':
      return { kind: 'review' };
  }
}

export interface AskInput {
  /** The connected wallet, or `undefined` when none is connected. */
  taker: string | undefined;
  pay: SwapToken | null;
  receive: SwapToken | null;
  pair: PairSupport | undefined;
  amount: AmountParse;
}

/**
 * The quote request, or `null` when there is nothing to ask. It depends on the wallet, the two
 * tokens, the pair and the amount, and on nothing else: not on balances.
 */
export function quoteAsk(i: AskInput): QuoteAsk | null {
  if (i.taker === undefined || i.pay === null || i.receive === null) return null;
  if (!i.pair?.ok || i.amount.kind !== 'ok') return null;
  return {
    sellToken: i.pay.ref,
    buyToken: i.receive.ref,
    sellAmount: i.amount.units,
    taker: i.taker,
    slippageBps: AUTO_SLIPPAGE_BPS,
  };
}

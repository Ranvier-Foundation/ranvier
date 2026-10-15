import type { MessageId, MessageParams } from '@/lib/i18n';
import type { CtaState } from './model';
import type { QuoteErrorKind } from './use-quote';

/** Button label per state: message ids only, so every string lives in the message file. */
export function ctaLabelId(state: CtaState): MessageId {
  switch (state.kind) {
    case 'connect':
      return 'swap.connect';
    case 'select-token':
      return 'swap.cta.select';
    case 'unsupported-pair':
      return state.reason === 'cross-chain' ? 'swap.cta.pair' : 'swap.cta.network';
    case 'enter-amount':
      return 'swap.enter';
    case 'amount-too-large':
      return 'swap.cta.too_large';
    case 'insufficient-balance':
      return 'swap.cta.insufficient';
    case 'fetching':
      return state.after === 'expiry' ? 'swap.cta.expired' : 'swap.cta.fetching';
    case 'expired':
      return 'swap.cta.refresh';
    case 'review':
      return 'swap.cta.review';
    case 'error':
      switch (state.error) {
        case 'no_route':
          return 'swap.cta.no_route';
        case 'price_unavailable':
          return 'swap.cta.price';
        case 'routing_unavailable':
          return 'swap.cta.routing';
        case 'clock':
          return 'swap.cta.clock';
        default:
          return 'swap.cta.unavailable';
      }
  }
}

const ERROR_NOTE: Record<QuoteErrorKind, MessageId> = {
  no_route: 'swap.note.no_route',
  routing_slow: 'swap.note.routing_slow',
  price_unavailable: 'swap.note.price',
  routing_unavailable: 'swap.note.routing',
  signing_unavailable: 'swap.note.signing',
  unavailable: 'swap.note.unavailable',
  network: 'swap.note.network',
  offline: 'swap.note.offline',
  timeout: 'swap.note.timeout',
  unconfigured: 'swap.note.unconfigured',
  clock: 'swap.note.clock',
};

/** What to show under the button, and the one action offered with it. */
export interface CtaNote {
  id: MessageId;
  params?: MessageParams;
  /** `retry` asks for a new quote; `balance` reads the balance again. */
  action?: 'retry' | 'balance';
}

export interface NoteContext {
  payChain: string;
  receiveChain: string;
  /** The last balance read, formatted, and the pay symbol (for the insufficient-balance hint). */
  balance?: string;
  paySymbol?: string;
  /** A picker answer this build does not list. */
  unknownToken: boolean;
}

export function ctaNote(state: CtaState, ctx: NoteContext): CtaNote | null {
  switch (state.kind) {
    case 'connect':
    case 'enter-amount':
      return ctx.unknownToken ? { id: 'swap.note.token.unknown' } : null;
    case 'select-token':
      return ctx.unknownToken ? { id: 'swap.note.token.unknown' } : null;
    case 'unsupported-pair':
      return state.reason === 'cross-chain'
        ? { id: 'swap.note.pair.cross', params: { pay: ctx.payChain, receive: ctx.receiveChain } }
        : { id: 'swap.note.pair.chain', params: { chain: ctx.payChain } };
    case 'amount-too-large':
      return { id: 'swap.note.too_large' };
    case 'insufficient-balance':
      return {
        id: 'swap.note.insufficient',
        params: {
          chain: ctx.payChain,
          balance: ctx.balance ?? '0',
          symbol: ctx.paySymbol ?? '',
        },
        action: 'balance',
      };
    case 'fetching':
      return state.after === 'expiry' ? { id: 'swap.note.fetching.expiry' } : null;
    case 'expired':
      return { id: 'swap.note.expired' };
    case 'review':
      return { id: 'swap.note.review' };
    case 'error':
      return {
        id: ERROR_NOTE[state.error],
        // An unconfigured site cannot be retried; no route needs a different amount, not a retry.
        ...(state.error === 'unconfigured' || state.error === 'no_route'
          ? {}
          : { action: 'retry' as const }),
      };
  }
}

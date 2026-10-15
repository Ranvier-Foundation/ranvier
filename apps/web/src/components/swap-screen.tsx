'use client';

import { useId, useState } from 'react';
import { formatUsd } from '@/lib/format';
import { t } from '@/lib/i18n';
import { ctaNote } from '@/lib/swap/copy';
import { formatSwapAmount } from '@/lib/swap/tokens';
import type { QuoteState } from '@/lib/swap/use-quote';
import { useSwap, type Side, type SwapForm } from '@/lib/swap/use-swap';
import { QuoteDetails, useSecondsLeft } from './quote-details';
import { SwapCta } from './swap-cta';
import { SwapPanel, type SwapPanelView } from './swap-panel';
import { TokenPicker } from './token-picker';

/** What a screen reader hears when a quote arrives: once per quote, never per second or keystroke. */
function announcement(form: SwapForm): string {
  const { quote, receive } = form;
  if (quote.status === 'ready' && receive !== null) {
    const symbol = receive.symbol;
    return t('swap.announce.ready', {
      amount: formatSwapAmount(quote.quote.buyAmount, receive),
      symbol,
      min: formatSwapAmount(quote.quote.minBuyAmount, receive),
    });
  }
  return '';
}

function panelView(form: SwapForm, quote: QuoteState, onPick: (s: Side) => void): SwapPanelView {
  const { pay, receive, amount } = form;
  const idle = amount.kind === 'empty' || amount.kind === 'zero';
  const zero = formatUsd(0n);
  const ready = quote.status === 'ready' && receive !== null ? quote.quote : undefined;
  return {
    pay: { chain: pay?.chain.name, symbol: pay?.symbol },
    receive: { chain: receive?.chain.name, symbol: receive?.symbol },
    amountText: form.amountText,
    onAmountChange: form.setAmount,
    receiveText:
      ready && receive ? formatSwapAmount(ready.buyAmount, receive) : t('swap.amount.placeholder'),
    receiveQuoted: ready !== undefined,
    receiveBusy: form.cta.kind === 'fetching',
    // The quote API sends no USD value for what is sold, so none is shown once an amount is
    // typed; 0 is exact.
    payUsd: idle ? zero : null,
    receiveUsd: ready?.kind === 'swap' ? formatUsd(ready.buyUsdCents) : idle ? zero : null,
    onPick,
    onFlip: form.flip,
  };
}

/** The route line under the button, with the expiry countdown. */
function QuoteStatus({ quote }: { quote: Extract<QuoteState, { status: 'ready' }> }) {
  const seconds = useSecondsLeft(quote.expiry);
  const q = quote.quote;
  const route =
    q.kind === 'wrap'
      ? t(q.direction === 'wrap' ? 'swap.route.wrap' : 'swap.route.unwrap')
      : q.routeCount > 1
        ? t('swap.route.best', { count: q.routeCount, provider: q.provider })
        : t('swap.route.one', { provider: q.provider });
  return (
    <p className="m-0 mt-16 flex items-center justify-center gap-10 text-caption text-sub">
      <span aria-hidden="true" className="size-7 shrink-0 bg-accent" />
      <span className="min-w-0">
        {route}
        {seconds === null ? null : (
          <>
            {' · '}
            <span className="num">{t('swap.expires', { seconds })}</span>
          </>
        )}
      </span>
    </p>
  );
}

/**
 * The connected swap screen up to a displayed quote: the panel, the button, the note that explains
 * the button, the route line with the expiry countdown, and the rate and fee breakdown. The token
 * names open the existing token picker in place. Nothing here signs, sends or builds a
 * transaction, and the final button does nothing yet (ADR 0011).
 */
export function SwapScreen() {
  const form = useSwap();
  const [picking, setPicking] = useState<Side | null>(null);
  const ids = useId();
  const noteId = `${ids}-note`;
  const view = panelView(form, form.quote, setPicking);

  const { pay, receive, cta, quote } = form;
  const note = ctaNote(cta, {
    payChain: pay?.chain.name ?? '',
    receiveChain: receive?.chain.name ?? '',
    unknownToken: form.unknownToken,
    ...(pay && form.payBalance !== undefined
      ? { balance: formatSwapAmount(form.payBalance, pay), paySymbol: pay.symbol }
      : {}),
  });
  // Said once per change: the ready quote, or the note that explains the button (not the
  // review note, which never changes, and not the countdown).
  const spoken =
    quote.status === 'ready'
      ? announcement(form)
      : note && cta.kind !== 'review'
        ? t(note.id, note.params)
        : '';
  const onNoteAction = note?.action === 'balance' ? form.refreshBalance : form.refreshQuote;
  const amount = form.amount;

  return (
    <>
      <SwapPanel view={view} />
      <div className="mt-16 flex justify-center">
        <SwapCta
          state={cta}
          onRefresh={form.refreshQuote}
          {...(note ? { describedBy: noteId } : {})}
        />
      </div>
      {note ? (
        <div
          id={noteId}
          className="mx-auto mt-12 flex max-w-popover flex-col items-center gap-4 text-center text-caption text-sub"
        >
          <p className="m-0">{t(note.id, note.params)}</p>
          {note.action ? (
            <button
              type="button"
              onClick={onNoteAction}
              className="hit-area h-32 rounded-pill border-none bg-transparent px-12 text-caption font-medium text-ink transition hover:bg-hover-row"
            >
              {t(note.action === 'balance' ? 'swap.note.balance.refresh' : 'swap.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
      {quote.status === 'ready' ? <QuoteStatus quote={quote} /> : null}
      {quote.status === 'ready' && pay && receive && amount.kind === 'ok' ? (
        <QuoteDetails quote={quote.quote} pay={pay} receive={receive} sellAmount={amount.units} />
      ) : null}
      <p role="status" aria-label={t('swap.status.label')} className="sr-only">
        {spoken}
      </p>
      {picking ? (
        <TokenPicker
          onClose={() => setPicking(null)}
          onSelect={(ref) => {
            form.select(picking, ref);
            setPicking(null);
          }}
        />
      ) : null}
    </>
  );
}

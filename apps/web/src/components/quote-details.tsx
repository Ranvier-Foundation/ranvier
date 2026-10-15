'use client';

import { useEffect, useId, useState } from 'react';
import { feeSummary, formatBps } from '@/lib/fee-copy';
import { formatUsd } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { ApiQuote, QuoteFee } from '@/lib/api/quote';
import { realClock, secondsLeft, type Expiry } from '@/lib/swap/expiry';
import { formatRate, unitRate, usdPerToken } from '@/lib/swap/rate';
import { formatSwapAmount, type SwapToken } from '@/lib/swap/tokens';
import { InfoIcon, RateArrowsIcon } from './icons';

/** Seconds left on a quote, re-read once a second. The text is not a live region (no spam). */
export function useSecondsLeft(expiry: Expiry | null): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (expiry === null) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [expiry]);
  return expiry === null ? null : secondsLeft(expiry, realClock);
}

function feeReason(fee: QuoteFee): string {
  switch (fee.reason) {
    case 'wrap-unwrap':
      return t('swap.details.fee.reason.wrap-unwrap');
    case 'first-swap-promo':
      return t('swap.details.fee.reason.first-swap-promo', {
        waived: formatUsd(fee.waivedUsdCents),
      });
    case 'stablecoin':
      return t('swap.details.fee.reason.stablecoin');
    case 'tier-under-10k':
      return t('swap.details.fee.reason.tier', { range: feeSummary().tier1Range });
    case 'tier-10k-100k':
      return t('swap.details.fee.reason.tier', { range: feeSummary().tier2Range });
    case 'tier-over-100k':
      return t('swap.details.fee.reason.tier', { range: feeSummary().tier3Range });
  }
}

export interface QuoteDetailsProps {
  quote: ApiQuote;
  pay: SwapToken;
  receive: SwapToken;
  /** The amount sold, in base units, before the fee. */
  sellAmount: bigint;
}

/**
 * The rate line and its fee breakdown (canvas: the rate pill and its "Rates and fees" popover).
 * Everything comes from the quote the API signed: the rate from its amounts (bigint division, no
 * float), the fee from `fee` (its rate, its exact amount and its reason, never a number typed
 * here), the network cost and the route from the quote. The canvas opens the popover on hover;
 * here it is a disclosure button, so keyboard and touch reach it, with a hairline instead of a
 * shadow (see Deviations).
 */
export function QuoteDetails({ quote, pay, receive, sellAmount }: QuoteDetailsProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const perReceive = unitRate(sellAmount, quote.buyAmount, receive.decimals);
  const perPay = unitRate(quote.buyAmount, sellAmount, pay.decimals);
  if (perReceive === undefined || perPay === undefined) return null;
  const rate = formatRate(perReceive, pay.decimals);
  const inverse = formatRate(perPay, receive.decimals);
  const usd =
    quote.kind === 'swap'
      ? usdPerToken(quote.buyUsdCents, quote.buyAmount, receive.decimals)
      : undefined;
  const { fee } = quote;
  const feeValue =
    fee.amount === 0n
      ? t('fee.free')
      : t('swap.details.fee.value', {
          rate: formatBps(fee.bps),
          amount: formatSwapAmount(fee.amount, pay),
          symbol: pay.symbol,
        });

  return (
    <div className="mt-12 flex flex-col items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('swap.rate.label', { receive: receive.symbol, rate, pay: pay.symbol })}
        onClick={() => setOpen((v) => !v)}
        className="hit-area flex h-36 items-center gap-8 rounded-pill border-none bg-transparent px-12 text-caption text-ink transition hover:bg-hover-row"
      >
        <span className="num">1 {receive.symbol}</span>
        <RateArrowsIcon />
        <span className="num">
          {rate} {pay.symbol}
        </span>
        {usd === undefined ? null : <span className="num text-sub">{usd}</span>}
        <span className="text-sub">
          <InfoIcon />
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          className="mt-8 w-full max-w-popover border border-line bg-surface p-18 text-caption"
        >
          <h2 className="m-0 text-lead font-medium">{t('swap.details.title')}</h2>
          <dl className="m-0 mt-14 grid grid-cols-[minmax(0,1fr)_auto] gap-x-12 gap-y-6">
            <dt className="num">
              {t('swap.details.rate', { from: receive.symbol, rate, to: pay.symbol })}
            </dt>
            <dd className="num m-0 text-right text-sub">{usd ?? ''}</dd>
            <dt className="num">
              {t('swap.details.rate', { from: pay.symbol, rate: inverse, to: receive.symbol })}
            </dt>
            <dd className="m-0" />
          </dl>
          {fee.amount === 0n ? null : (
            <p className="m-0 mt-8 text-sub">{t('swap.details.rate.note')}</p>
          )}
          <dl className="m-0 mt-12 grid grid-cols-[minmax(0,1fr)_auto] gap-x-12 gap-y-6 border-t border-line pt-12">
            <dt className="text-sub">{t('swap.details.fee')}</dt>
            <dd className="num m-0 text-right">{feeValue}</dd>
            {fee.reason === 'first-swap-promo' ? (
              <>
                <dt className="text-sub">{t('swap.details.waiver')}</dt>
                <dd className="num m-0 text-right">{formatUsd(fee.waivedUsdCents)}</dd>
              </>
            ) : null}
            {quote.kind === 'swap' ? (
              <>
                <dt className="text-sub">{t('swap.details.gas')}</dt>
                <dd className="num m-0 text-right">{formatUsd(quote.networkCostUsdCents)}</dd>
              </>
            ) : null}
            <dt className="text-sub">{t('swap.details.min')}</dt>
            <dd className="num m-0 text-right">
              {formatSwapAmount(quote.minBuyAmount, receive)} {receive.symbol}
            </dd>
            {quote.kind === 'swap' ? (
              <>
                <dt className="text-sub">{t('swap.details.route')}</dt>
                <dd className="m-0 text-right">{quote.provider}</dd>
              </>
            ) : null}
          </dl>
          <p className="m-0 mt-12 text-sub">{feeReason(fee)}</p>
          {quote.kind === 'swap' ? (
            <p className="m-0 mt-6 text-sub">{t('swap.details.fee.signed')}</p>
          ) : null}
          <p className="m-0 mt-6 text-sub">{t('swap.details.min.note')}</p>
        </div>
      ) : null}
    </div>
  );
}

import Link from 'next/link';
import { defaultPair } from '@/lib/defaults';
import { formatUsd } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { Side } from '@/lib/swap/use-swap';

const AMOUNT = 'num text-amount';
const TOKEN_NAME = `${AMOUNT} text-sub no-underline transition hover:text-accent focus-visible:text-accent`;

/** One side of the panel as text: both fields are `undefined` for a side with no token chosen. */
export interface PanelSide {
  chain: string | undefined;
  symbol: string | undefined;
}

/**
 * Everything the panel shows. The signed-out and `/select-token` screens use the static view (the
 * registry's default pair, empty fields); the live swap screen passes real state and handlers.
 * Without handlers the chain and token names are links to the picker route, as on the canvas.
 */
export interface SwapPanelView {
  pay: PanelSide;
  receive: PanelSide;
  /** With `onAmountChange` the field is controlled; without it, it is an empty uncontrolled field. */
  amountText?: string;
  onAmountChange?: (raw: string) => void;
  /** Id of the element that explains the amount field (an error or a hint). */
  amountDescribedBy?: string;
  /** What the receive row shows: the quoted amount, or the placeholder. */
  receiveText: string;
  /** `receiveText` is a quoted amount (shown in `ink`, as the canvas does), not the placeholder. */
  receiveQuoted?: boolean;
  /** A quote is being fetched: the receive amount is a placeholder block, not a number. */
  receiveBusy?: boolean;
  /** USD value texts. `null` hides the value (it is not known). */
  payUsd: string | null;
  receiveUsd: string | null;
  onPick?: (side: Side) => void;
  onFlip?: () => void;
}

export function staticView(): SwapPanelView {
  const { pay, receive } = defaultPair();
  const zero = formatUsd(0n);
  return {
    pay: { chain: pay.chain.name, symbol: pay.symbol },
    receive: { chain: receive.chain.name, symbol: receive.symbol },
    receiveText: t('swap.amount.placeholder'),
    payUsd: zero,
    receiveUsd: zero,
  };
}

/** The row heading as plain text: "Pay on Ethereum", or "Pay" when no token is chosen. */
function headingText(side: Side, view: SwapPanelView): string {
  const { chain } = view[side];
  if (chain === undefined) {
    return t(side === 'pay' ? 'swap.pay.heading.none' : 'swap.receive.heading.none');
  }
  return t(side === 'pay' ? 'swap.pay.heading' : 'swap.receive.heading', { chain });
}

/** "Pay on Ethereum": the chain name opens the token picker (a link to the route when static). */
function RowHeading({
  htmlFor,
  side,
  view,
}: {
  htmlFor: string;
  side: Side;
  view: SwapPanelView;
}) {
  const { chain } = view[side];
  if (chain === undefined) {
    return (
      <label htmlFor={htmlFor} className="text-small text-sub">
        {t(side === 'pay' ? 'swap.pay.heading.none' : 'swap.receive.heading.none')}
      </label>
    );
  }
  const text = t(side === 'pay' ? 'swap.pay.heading' : 'swap.receive.heading', { chain });
  const [before, after] = text.split(chain);
  const label = t('swap.chain.change.label', { chain });
  const style =
    'hit-area text-sub no-underline transition hover:text-accent focus-visible:text-accent';
  return (
    <label htmlFor={htmlFor} className="text-small text-sub">
      {before}
      {view.onPick ? (
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          onClick={() => view.onPick?.(side)}
          className={`${style} border-none bg-transparent p-0`}
        >
          {chain}
        </button>
      ) : (
        <Link href="/select-token" aria-label={label} className={style}>
          {chain}
        </Link>
      )}
      {after}
    </label>
  );
}

function TokenName({ side, view }: { side: Side; view: SwapPanelView }) {
  const { symbol } = view[side];
  const label =
    symbol === undefined
      ? t(side === 'pay' ? 'swap.pay.token.none.label' : 'swap.receive.token.none.label')
      : t(side === 'pay' ? 'swap.pay.token.label' : 'swap.receive.token.label', { token: symbol });
  const shown = symbol ?? t('swap.token.none');
  return view.onPick ? (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      onClick={() => view.onPick?.(side)}
      className={`${TOKEN_NAME} border-none bg-transparent p-0`}
    >
      {shown}
    </button>
  ) : (
    <Link href="/select-token" aria-label={label} className={TOKEN_NAME}>
      {shown}
    </Link>
  );
}

function SlippageIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d="M3 8h18M3 16h18" />
      <rect className="fill-surface" x="6.5" y="5.5" width="5" height="5" />
      <rect className="fill-surface" x="12.5" y="13.5" width="5" height="5" />
    </svg>
  );
}

/**
 * The swap panel (canvas: Web Swap, connected and signed out). Presentational: the view says what
 * to show. USD values are shown only when known; the pay side has none from the quote API.
 */
export function SwapPanel({ view = staticView() }: { view?: SwapPanelView }) {
  const controlled = view.onAmountChange !== undefined;
  return (
    <section aria-label={t('swap.panel.label')} className="mx-auto max-w-panel bg-surface">
      <div className="px-24 pt-24 pb-32">
        <div className="flex items-center justify-between gap-12">
          <RowHeading htmlFor="pay" side="pay" view={view} />
          <Link
            href="/settings"
            aria-label={t('swap.settings.label')}
            className="hit-area flex h-32 items-center gap-6 text-caption text-sub no-underline transition hover:opacity-70"
          >
            {t('swap.settings.auto')}
            <SlippageIcon />
          </Link>
        </div>
        <div className="mt-30 flex flex-wrap items-baseline justify-between gap-x-16 gap-y-4">
          <div className="flex max-w-full min-w-0 items-baseline gap-10 whitespace-nowrap">
            <input
              id="pay"
              inputMode="decimal"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t('swap.amount.placeholder')}
              {...(controlled
                ? {
                    value: view.amountText ?? '',
                    onChange: (e: { target: { value: string } }) =>
                      view.onAmountChange?.(e.target.value),
                  }
                : {})}
              /* The label holds a button (the chain name), whose name would end up in the field's: the field is named by the plain heading. */
              aria-label={headingText('pay', view)}
              {...(view.amountDescribedBy ? { 'aria-describedby': view.amountDescribedBy } : {})}
              className={`${AMOUNT} -mx-4 min-w-field-min field-sizing-content border-none bg-transparent px-4 font-normal placeholder:text-sub`}
            />
            <TokenName side="pay" view={view} />
          </div>
          {view.payUsd === null ? null : (
            <button
              type="button"
              aria-label={t('swap.pay.usd.label')}
              className="num ml-auto shrink-0 border-none bg-transparent p-0 text-body text-accent transition hover:opacity-70"
            >
              {view.payUsd}
            </button>
          )}
        </div>
      </div>

      <div className="relative h-px bg-line">
        <button
          type="button"
          aria-label={t('swap.flip.label')}
          {...(view.onFlip ? { onClick: view.onFlip } : {})}
          className="absolute -top-22 left-half -ml-22 flex size-control items-center justify-center bg-primary outline-primary transition hover:opacity-88"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="fill-blush">
            <rect x="0" y="9" width="7" height="7" />
            <rect x="9" y="0" width="7" height="7" />
          </svg>
        </button>
      </div>

      <div className="px-24 pt-32 pb-26">
        <RowHeading htmlFor="receive" side="receive" view={view} />
        <div className="mt-30 flex flex-wrap items-baseline justify-between gap-x-16 gap-y-4">
          <div className="flex max-w-full min-w-0 items-baseline gap-10 whitespace-nowrap">
            {/* An <output> is a live region by default; the quote is announced once, by the status line, not on every change. */}
            <output
              id="receive"
              htmlFor="pay"
              aria-live="off"
              aria-busy={view.receiveBusy === true}
              className={`${AMOUNT} min-w-0 truncate ${view.receiveQuoted ? 'text-ink' : 'text-sub'}`}
            >
              {view.receiveBusy ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-28 w-120 rounded-pill bg-pill align-middle"
                  />
                  <span className="sr-only">{t('swap.receive.loading')}</span>
                </>
              ) : (
                view.receiveText
              )}
            </output>
            <TokenName side="receive" view={view} />
          </div>
          {view.receiveUsd === null ? null : (
            <span className="num ml-auto shrink-0 text-body text-sub">{view.receiveUsd}</span>
          )}
        </div>
      </div>
    </section>
  );
}

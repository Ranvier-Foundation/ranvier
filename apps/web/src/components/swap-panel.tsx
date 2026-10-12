import Link from 'next/link';
import { defaultPair, type DefaultSide } from '@/lib/defaults';
import { formatUsd } from '@/lib/format';
import { t } from '@/lib/i18n';

const AMOUNT = 'num text-amount';

/** "Pay on Ethereum": the chain name is a link to the chain picker (a later screen). */
function RowHeading({ htmlFor, text, chain }: { htmlFor: string; text: string; chain: string }) {
  const [before, after] = text.split(chain);
  return (
    <label htmlFor={htmlFor} className="text-small text-sub">
      {before}
      <Link
        href="/select-token"
        aria-label={t('swap.chain.change.label', { chain })}
        className="text-sub no-underline transition hover:text-accent focus-visible:text-accent"
      >
        {chain}
      </Link>
      {after}
    </label>
  );
}

function TokenName({ side, label }: { side: DefaultSide; label: string }) {
  return (
    <Link
      href="/select-token"
      aria-label={label}
      className={`${AMOUNT} text-sub no-underline transition hover:text-accent focus-visible:text-accent`}
    >
      {side.symbol}
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

/** Signed-out swap panel: the artboard's panel, with empty amount fields and registry defaults. */
export function SwapPanel() {
  const { pay, receive } = defaultPair();
  const zeroUsd = formatUsd(0n);
  return (
    <section aria-label={t('swap.panel.label')} className="mx-auto max-w-panel bg-surface">
      <div className="px-24 pt-24 pb-32">
        <div className="flex items-center justify-between gap-12">
          <RowHeading
            htmlFor="pay"
            text={t('swap.pay.heading', { chain: pay.chain.name })}
            chain={pay.chain.name}
          />
          <Link
            href="/settings"
            aria-label={t('swap.settings.label')}
            className="flex h-32 items-center gap-6 text-caption text-sub no-underline transition hover:opacity-70"
          >
            {t('swap.settings.auto')}
            <SlippageIcon />
          </Link>
        </div>
        <div className="mt-30 flex items-baseline justify-between gap-16 whitespace-nowrap">
          <div className="flex min-w-0 items-baseline gap-10">
            <input
              id="pay"
              inputMode="decimal"
              autoComplete="off"
              placeholder={t('swap.amount.placeholder')}
              className={`${AMOUNT} -mx-4 min-w-field-min field-sizing-content border-none bg-transparent px-4 font-normal placeholder:text-sub`}
            />
            <TokenName side={pay} label={t('swap.pay.token.label', { token: pay.symbol })} />
          </div>
          <button
            type="button"
            aria-label={t('swap.pay.usd.label')}
            className="num shrink-0 border-none bg-transparent p-0 text-body text-accent transition hover:opacity-70"
          >
            {zeroUsd}
          </button>
        </div>
      </div>

      <div className="relative h-px bg-line">
        <button
          type="button"
          aria-label={t('swap.flip.label')}
          className="absolute -top-22 left-half -ml-22 flex size-control items-center justify-center bg-primary outline-primary transition hover:opacity-88"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="fill-blush">
            <rect x="0" y="9" width="7" height="7" />
            <rect x="9" y="0" width="7" height="7" />
          </svg>
        </button>
      </div>

      <div className="px-24 pt-32 pb-26">
        <RowHeading
          htmlFor="receive"
          text={t('swap.receive.heading', { chain: receive.chain.name })}
          chain={receive.chain.name}
        />
        <div className="mt-30 flex items-baseline justify-between gap-16 whitespace-nowrap">
          <div className="flex min-w-0 items-baseline gap-10">
            <output id="receive" htmlFor="pay" className={`${AMOUNT} text-sub`}>
              {t('swap.amount.placeholder')}
            </output>
            <TokenName
              side={receive}
              label={t('swap.receive.token.label', { token: receive.symbol })}
            />
          </div>
          <span className="num shrink-0 text-body text-sub">{zeroUsd}</span>
        </div>
      </div>
    </section>
  );
}

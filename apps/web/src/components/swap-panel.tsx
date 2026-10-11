import { MAX_FEE_BPS } from '@ranvier/fees';

function TokenField({ label, symbol }: { label: string; symbol: string }) {
  const id = `amount-${label.toLowerCase()}`;
  return (
    <div className="bg-chip p-4">
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      <div className="mt-2 flex items-center gap-3">
        <input
          id={id}
          inputMode="decimal"
          placeholder="0"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-3xl font-medium outline-none placeholder:text-muted"
        />
        <button type="button" className="h-11 shrink-0 rounded-full bg-surface px-4 font-medium">
          {symbol}
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">$0.00</p>
    </div>
  );
}

export function SwapPanel() {
  return (
    <section aria-labelledby="swap-heading" className="w-full max-w-[480px] bg-surface p-4">
      <h1 id="swap-heading" className="px-1 pb-3 text-lg font-semibold">
        Swap
      </h1>
      <div className="flex flex-col gap-1">
        <TokenField label="You pay" symbol="ETH" />
        <TokenField label="You receive" symbol="USDC" />
      </div>
      <button
        type="button"
        disabled
        className="mt-4 h-14 w-full rounded-full bg-brand-deep text-base font-medium text-white disabled:opacity-60"
      >
        Connect wallet to swap
      </button>
      <p className="mt-3 text-center text-xs text-muted">
        Platform fee 0.05% to 0.2%, never more than {MAX_FEE_BPS / 100}%. Shown before you sign.
      </p>
    </section>
  );
}

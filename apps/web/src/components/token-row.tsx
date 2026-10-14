import { formatTokenAmount, shortAddress } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { PickerRow } from '@/lib/picker/model';
import { TokenAvatar } from './token-avatar';

/** Stablecoins read like money: two places, as the canvas shows "2,410.50". */
const STABLE_PLACES = 2;

/**
 * The balance as text, or undefined when none is shown: nothing is shown for a zero balance (the
 * list is of what you hold; a column of zeros is noise) or an unknown one. Display only (ADR 0009).
 */
export function balanceText(row: PickerRow): string | undefined {
  if (row.balance.state !== 'known' || row.balance.amount === 0n) return undefined;
  return formatTokenAmount(
    row.balance.amount,
    row.token.decimals,
    row.token.tags.includes('stablecoin') ? { fixed: STABLE_PLACES } : {},
  );
}

export interface TokenRowProps {
  row: PickerRow;
  id: string;
  active: boolean;
  /**
   * Show the token's short address after the chain name. Set when another token on screen shares
   * the symbol, so the user can tell them apart. Text only, never a link. A native coin has no
   * address, so it shows none.
   */
  showAddress?: boolean;
  onPick: (row: PickerRow) => void;
}

/**
 * One option of the token listbox. A div with `role="option"`, not a button: focus stays in the
 * search field and the arrow keys move `aria-activedescendant` (combobox with listbox popup).
 * Everything the API sent is rendered as text.
 */
export function TokenRow({ row, id, active, showAddress = false, onPick }: TokenRowProps) {
  const { token, chain } = row;
  const balance = balanceText(row);
  const params = { symbol: token.symbol, name: token.name, chain: chain.name };
  const address =
    showAddress && token.address !== 'native' ? shortAddress(token.address) : undefined;
  const label =
    balance === undefined
      ? t('picker.row.label', params)
      : t('picker.row.label.balance', { ...params, amount: balance });
  return (
    <div
      role="option"
      id={id}
      aria-selected={active}
      data-active={active}
      aria-label={address === undefined ? label : t('picker.row.label.address', { label, address })}
      onClick={() => onPick(row)}
      className="flex min-h-64 cursor-pointer items-center gap-14 px-12 transition hover:bg-bg max-narrow:gap-12"
    >
      <TokenAvatar symbol={token.symbol} chain={chain.key} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{token.symbol}</span>
        <span className="flex gap-4 text-caption text-sub">
          <span className="min-w-0 truncate">
            <span className="max-narrow:hidden">{t('picker.row.name', { name: token.name })}</span>
            {chain.name}
          </span>
          {address === undefined ? null : (
            <span className="addr shrink-0">{t('picker.row.address', { address })}</span>
          )}
        </span>
      </span>
      {row.balance.state === 'loading' ? (
        <span aria-hidden="true" className="block h-14 w-48 shrink-0 rounded-pill bg-pill" />
      ) : balance !== undefined ? (
        <span className="num shrink-0 text-right font-medium">{balance}</span>
      ) : null}
    </div>
  );
}

/** Placeholder rows while the token list loads: static blocks, no motion. */
export function TokenRowsSkeleton({ count }: { count: number }) {
  return (
    <div aria-hidden="true" className="px-12 max-narrow:px-8">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex min-h-64 items-center gap-14 px-12 max-narrow:gap-12">
          <span className="size-40 shrink-0 rounded-round bg-pill" />
          <span className="flex-1">
            <span className="block h-14 w-48 rounded-pill bg-pill" />
            <span className="mt-6 block h-12 w-120 rounded-pill bg-pill" />
          </span>
          <span className="h-14 w-48 shrink-0 rounded-pill bg-pill" />
        </div>
      ))}
    </div>
  );
}

import { chainBg } from '@/lib/chain-style';

const SIZES = {
  /** Quick-pick chip: 28 px. */
  sm: 'size-28 text-tag',
  /** List row: 40 px. */
  md: 'size-40 text-small',
} as const;

export interface TokenAvatarProps {
  symbol: string;
  /** Registry chain key; draws the 16 px network badge bottom right. Omit for no badge. */
  chain?: string;
  size?: keyof typeof SIZES;
}

/**
 * Token avatar (docs/ui-guidelines.md): a circle with the symbol's first letter and, in a list, a
 * 16 px badge in the network colour ringed in white. There is no token colour or logo from the API
 * (ADR 0006: `logoUri` is unset and logos would need their own CSP decision), so every token gets
 * the neutral `pill` fill instead of an invented brand colour. Decorative: the row names the token.
 */
export function TokenAvatar({ symbol, chain, size = 'md' }: TokenAvatarProps) {
  return (
    <span aria-hidden="true" className={`relative flex shrink-0 ${SIZES[size]}`}>
      <span
        className={`flex size-full items-center justify-center rounded-round bg-pill font-bold text-ink`}
      >
        {Array.from(symbol)[0]?.toUpperCase()}
      </span>
      {chain ? (
        <span
          className={`absolute -right-2 -bottom-2 size-16 rounded-round border-2 border-surface ${chainBg(chain)}`}
        />
      ) : null}
    </span>
  );
}

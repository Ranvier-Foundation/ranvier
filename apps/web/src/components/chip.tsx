import type { ComponentProps, ReactNode } from 'react';

/**
 * The pill chip. `filter` is the 36 px chain filter (`pill` fill, `primary` when selected);
 * `token` is the 40 px bordered quick pick. Both keep their drawn height and carry a 44 px hit
 * area (`hit-area`).
 */
const VARIANTS = {
  filter:
    'h-36 gap-6 border-none pr-12 pl-8 text-caption font-medium max-narrow:px-14 max-narrow:shrink-0',
  token: 'h-40 gap-8 border border-line bg-transparent pr-14 pl-6 text-small font-medium',
} as const;

export interface ChipProps extends Omit<ComponentProps<'button'>, 'type'> {
  variant?: keyof typeof VARIANTS;
  /** `filter` only: the chip is the current choice (`aria-pressed`). */
  selected?: boolean;
  children: ReactNode;
}

export function Chip({
  variant = 'filter',
  selected,
  className = '',
  children,
  ...rest
}: ChipProps) {
  const tone =
    variant === 'filter'
      ? selected
        ? 'bg-primary text-on-primary outline-primary'
        : 'bg-pill text-ink'
      : 'text-ink';
  return (
    <button
      type="button"
      {...(variant === 'filter' ? { 'aria-pressed': selected === true } : {})}
      className={`hit-area flex items-center rounded-pill transition hover:brightness-95 ${VARIANTS[variant]} ${tone} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

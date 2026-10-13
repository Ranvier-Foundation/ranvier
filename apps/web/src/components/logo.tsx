/** The four reference wordmark sizes (docs/ui-guidelines.md section 4). */
export const LOGO_SIZES = [32, 29, 22, 15] as const;
export type LogoSize = (typeof LOGO_SIZES)[number];

export type LogoTone = 'light' | 'deep';

const SIZE_CLASS: Record<LogoSize, string> = {
  32: 'logo-32',
  29: 'logo-29',
  22: 'logo-22',
  15: 'logo-15',
};

/**
 * Wordmark and Hop mark. Built once; takes one of the four reference wordmark sizes. The
 * geometry is a set of design tokens (`--logo-<size>-*`, tokens.css) applied by class
 * (globals.css), so the markup has no inline style.
 */
export function Logo({ size, tone = 'light' }: { size: LogoSize; tone?: LogoTone }) {
  const word = tone === 'deep' ? 'text-on-primary' : 'text-ink';
  const node = tone === 'deep' ? 'text-blush' : 'text-accent';
  return (
    <span
      data-logo={size}
      className={`logo ${SIZE_CLASS[size]} inline-flex items-start leading-none font-bold tracking-logo ${word}`}
    >
      ranvier
      <span
        aria-hidden="true"
        data-logo-mark=""
        className={`logo-mark relative shrink-0 self-end ${node}`}
      >
        <span className="logo-square logo-square-low absolute bg-current" />
        <span className="logo-square logo-square-high absolute bg-current" />
      </span>
    </span>
  );
}

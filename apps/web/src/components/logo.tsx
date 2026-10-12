import { logoGeometry } from './logo-geometry';

export type LogoTone = 'light' | 'deep';

/** Wordmark and Hop mark. Built once; takes the wordmark size in whole pixels. */
export function Logo({ size, tone = 'light' }: { size: number; tone?: LogoTone }) {
  const g = logoGeometry(size);
  const word = tone === 'deep' ? 'text-on-primary' : 'text-ink';
  const node = tone === 'deep' ? 'text-blush' : 'text-accent';
  return (
    <span
      data-logo={size}
      className={`inline-flex items-start leading-none font-bold tracking-logo ${word}`}
      style={{ fontSize: g.fontSize }}
    >
      ranvier
      <span
        aria-hidden="true"
        data-logo-mark=""
        className={`relative shrink-0 self-end ${node}`}
        style={{ width: g.box, height: g.box, marginBottom: g.lift, marginLeft: g.spaceBefore }}
      >
        <span
          className="absolute bg-current"
          style={{ left: 0, top: g.step, width: g.square, height: g.square }}
        />
        <span
          className="absolute bg-current"
          style={{ left: g.step, top: 0, width: g.square, height: g.square }}
        />
      </span>
    </span>
  );
}

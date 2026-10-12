/**
 * Hop logo geometry, in whole pixels, from the wordmark font size `fs` (docs/ui-guidelines.md
 * section 4). The formulas are the canvas's own: square 0.15 fs at 60 px and above, 0.19 fs
 * below; gap 0.04 fs / 0.055 fs (minimum 1 px); the upper square tops out at the x-height; the
 * lower-left square floats 0.2 fs above the baseline; 0.09 fs from the "r".
 */
export interface LogoGeometry {
  fontSize: number;
  square: number;
  gap: number;
  /** Distance between the two squares' origins: one square plus one gap. */
  step: number;
  /** Side of the square mark box. */
  box: number;
  /** Bottom margin that lifts the mark above the baseline. */
  lift: number;
  /** Space between the wordmark and the mark. */
  spaceBefore: number;
}

const X_HEIGHT_OFFSET = 0.1367;
const X_HEIGHT = 0.55;

export function logoGeometry(fs: number): LogoGeometry {
  if (!Number.isInteger(fs) || fs <= 0)
    throw new RangeError('Logo size must be a whole number of pixels');
  const small = fs < 60;
  const square = Math.round(fs * (small ? 0.19 : 0.15));
  const gap = Math.max(1, Math.round(fs * (small ? 0.055 : 0.04)));
  const step = square + gap;
  const box = step + square;
  return {
    fontSize: fs,
    square,
    gap,
    step,
    box,
    lift: Math.round(X_HEIGHT_OFFSET * fs + X_HEIGHT * fs - box),
    spaceBefore: Math.max(2, Math.round(0.09 * fs)),
  };
}

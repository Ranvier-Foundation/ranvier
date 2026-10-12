import { FEE_SCHEDULE } from '@ranvier/fees';
import { formatUsd } from './format';
import { t } from './i18n';

/** Basis points as a percentage string: 20 -> "0.2%", 5 -> "0.05%", 30 -> "0.3%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toString()}%`;
}

/**
 * Display values for the fee schedule, derived from FEE_SCHEDULE so copy can never drift from
 * the rates the API signs. Used by FAQ and fee-explainer screens.
 */
export function feeSummary() {
  return {
    tier1: formatBps(FEE_SCHEDULE.tier1.bps),
    tier2: formatBps(FEE_SCHEDULE.tier2.bps),
    tier3: formatBps(FEE_SCHEDULE.tier3.bps),
    tier1UpTo: formatUsd(FEE_SCHEDULE.tier1.upperUsd),
    tier2UpTo: formatUsd(FEE_SCHEDULE.tier2.upperUsd),
    stablecoin: formatBps(FEE_SCHEDULE.stablecoinBps),
    wrapUnwrap:
      FEE_SCHEDULE.wrapUnwrapBps === 0 ? t('fee.free') : formatBps(FEE_SCHEDULE.wrapUnwrapBps),
    cap: formatBps(FEE_SCHEDULE.maxBps),
    firstSwapFree: formatUsd(FEE_SCHEDULE.firstSwapFreeUsd),
  };
}

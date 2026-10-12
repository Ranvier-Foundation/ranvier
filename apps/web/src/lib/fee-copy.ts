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
    /** Tier 1 applies strictly below this value. */
    tier1Below: formatUsd(FEE_SCHEDULE.tier1.upperUsd),
    /** Tier 2 applies up to and including this value. */
    tier2UpToInclusive: formatUsd(FEE_SCHEDULE.tier2.upperUsd),
    tier1Range: t('fee.tier1.range', { limit: formatUsd(FEE_SCHEDULE.tier1.upperUsd) }),
    tier2Range: t('fee.tier2.range', {
      from: formatUsd(FEE_SCHEDULE.tier1.upperUsd),
      to: formatUsd(FEE_SCHEDULE.tier2.upperUsd),
    }),
    tier3Range: t('fee.tier3.range', { limit: formatUsd(FEE_SCHEDULE.tier2.upperUsd) }),
    stablecoin: formatBps(FEE_SCHEDULE.stablecoinBps),
    wrapUnwrap:
      FEE_SCHEDULE.wrapUnwrapBps === 0 ? t('fee.free') : formatBps(FEE_SCHEDULE.wrapUnwrapBps),
    cap: formatBps(FEE_SCHEDULE.maxBps),
    firstSwapFree: formatUsd(FEE_SCHEDULE.firstSwapFreeUsd),
  };
}

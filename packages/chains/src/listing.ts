/**
 * Live chain criteria and delisting process (spec section 5).
 * All thresholds are config so they can be tuned without code changes.
 */
export interface ListingThresholds {
  minDexTvlUsd: number;
  minPoolDepthUsd: number;
  maxHeadAgeSeconds: number;
  minWorkingRpcs: number;
  daysFailingToHide: number;
  daysFailingToDelist: number;
  daysPassingToRelist: number;
}

export const DEFAULT_THRESHOLDS: ListingThresholds = {
  minDexTvlUsd: 1_000_000,
  minPoolDepthUsd: 100_000,
  maxHeadAgeSeconds: 300,
  minWorkingRpcs: 2,
  daysFailingToHide: 14,
  daysFailingToDelist: 30,
  daysPassingToRelist: 14,
};

export interface ChainHealthSnapshot {
  dexTvlUsd: number;
  deepestPoolUsd: number;
  headAgeSeconds: number;
  workingRpcs: number;
  hasRoutingProvider: boolean;
  /** Sunset announced, active halt or unresolved exploit, or paused canonical bridge. */
  hardExclusion: boolean;
}

export function failedCriteria(s: ChainHealthSnapshot, t = DEFAULT_THRESHOLDS): string[] {
  const failed: string[] = [];
  if (s.hardExclusion) failed.push('hard-exclusion');
  if (s.dexTvlUsd < t.minDexTvlUsd) failed.push('dex-tvl');
  if (s.deepestPoolUsd < t.minPoolDepthUsd) failed.push('pool-depth');
  if (s.headAgeSeconds > t.maxHeadAgeSeconds) failed.push('head-age');
  if (s.workingRpcs < t.minWorkingRpcs) failed.push('rpcs');
  if (!s.hasRoutingProvider) failed.push('routing');
  return failed;
}

export type ListingStatus = 'listed' | 'hidden' | 'delisted';

export interface ListingState {
  status: ListingStatus;
  consecutiveFailingDays: number;
  consecutivePassingDays: number;
}

/**
 * Advances a chain's listing state by one daily health check.
 * Hard exclusions hide the chain immediately; the day counters still run so it
 * can be delisted at 30 days and relisted after 14 passing days.
 */
export function nextListingState(
  prev: ListingState,
  snapshot: ChainHealthSnapshot,
  t = DEFAULT_THRESHOLDS,
): ListingState {
  const passing = failedCriteria(snapshot, t).length === 0;
  const failingDays = passing ? 0 : prev.consecutiveFailingDays + 1;
  const passingDays = passing ? prev.consecutivePassingDays + 1 : 0;

  let status = prev.status;
  if (passing) {
    if (status !== 'listed' && passingDays >= t.daysPassingToRelist) status = 'listed';
  } else if (failingDays >= t.daysFailingToDelist) {
    status = 'delisted';
  } else if (
    status === 'listed' &&
    (snapshot.hardExclusion || failingDays >= t.daysFailingToHide)
  ) {
    status = 'hidden';
  }
  return { status, consecutiveFailingDays: failingDays, consecutivePassingDays: passingDays };
}

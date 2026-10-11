import { describe, expect, it } from 'vitest';
import {
  failedCriteria,
  nextListingState,
  type ChainHealthSnapshot,
  type ListingState,
} from './listing.js';

const healthy: ChainHealthSnapshot = {
  dexTvlUsd: 5_000_000,
  deepestPoolUsd: 500_000,
  headAgeSeconds: 12,
  workingRpcs: 3,
  hasRoutingProvider: true,
  hardExclusion: false,
};
const unhealthy: ChainHealthSnapshot = { ...healthy, dexTvlUsd: 10 };
const listed: ListingState = {
  status: 'listed',
  consecutiveFailingDays: 0,
  consecutivePassingDays: 0,
};

function run(state: ListingState, snapshot: ChainHealthSnapshot, days: number): ListingState {
  for (let i = 0; i < days; i++) state = nextListingState(state, snapshot);
  return state;
}

describe('failedCriteria', () => {
  it('passes a healthy chain', () => {
    expect(failedCriteria(healthy)).toEqual([]);
  });

  it('reports every failing criterion', () => {
    expect(
      failedCriteria({
        dexTvlUsd: 0,
        deepestPoolUsd: 0,
        headAgeSeconds: 301,
        workingRpcs: 1,
        hasRoutingProvider: false,
        hardExclusion: true,
      }),
    ).toEqual(['hard-exclusion', 'dex-tvl', 'pool-depth', 'head-age', 'rpcs', 'routing']);
  });
});

describe('nextListingState', () => {
  it('hides after 14 failing days, not 13', () => {
    expect(run(listed, unhealthy, 13).status).toBe('listed');
    expect(run(listed, unhealthy, 14).status).toBe('hidden');
  });

  it('delists after 30 failing days', () => {
    expect(run(listed, unhealthy, 29).status).toBe('hidden');
    expect(run(listed, unhealthy, 30).status).toBe('delisted');
  });

  it('hides immediately on a hard exclusion', () => {
    expect(run(listed, { ...healthy, hardExclusion: true }, 1).status).toBe('hidden');
  });

  it('relists after 14 passing days', () => {
    const delisted = run(listed, unhealthy, 30);
    expect(run(delisted, healthy, 13).status).toBe('delisted');
    expect(run(delisted, healthy, 14).status).toBe('listed');
  });

  it('resets the failing counter on a passing day', () => {
    const state = run(run(listed, unhealthy, 13), healthy, 1);
    expect(run(state, unhealthy, 13).status).toBe('listed');
  });
});

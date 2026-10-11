import { describe, expect, it } from 'vitest';
import type { ChainHealthSnapshot, ListingState } from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import { runChainHealthCheck, type ListingStore } from './chain-health.js';

const healthy: ChainHealthSnapshot = {
  dexTvlUsd: 5_000_000,
  deepestPoolUsd: 500_000,
  headAgeSeconds: 10,
  workingRpcs: 3,
  hasRoutingProvider: true,
  hardExclusion: false,
};

function memoryStore(): ListingStore & { data: Map<ChainKey, ListingState> } {
  const data = new Map<ChainKey, ListingState>();
  return { data, get: async (c) => data.get(c), set: async (c, s) => void data.set(c, s) };
}

describe('runChainHealthCheck', () => {
  it('records state for every chain', async () => {
    const store = memoryStore();
    const results = await runChainHealthCheck({ snapshot: async () => healthy }, store);
    expect(results.every((r) => r.status === 'listed')).toBe(true);
    expect(store.data.size).toBe(results.length);
  });

  it('hides a chain on a hard exclusion and reports why', async () => {
    const store = memoryStore();
    const [result] = await runChainHealthCheck(
      { snapshot: async () => ({ ...healthy, hardExclusion: true }) },
      store,
      ['evm:1'],
    );
    expect(result).toEqual({ chain: 'evm:1', status: 'hidden', failed: ['hard-exclusion'] });
  });

  it('does not count a failed data fetch as a failing day', async () => {
    const store = memoryStore();
    store.data.set('evm:1', {
      status: 'listed',
      consecutiveFailingDays: 13,
      consecutivePassingDays: 0,
    });
    const [result] = await runChainHealthCheck(
      { snapshot: async () => Promise.reject(new Error('defillama down')) },
      store,
      ['evm:1'],
    );
    expect(result?.status).toBe('check-failed');
    expect(store.data.get('evm:1')?.consecutiveFailingDays).toBe(13);
  });
});

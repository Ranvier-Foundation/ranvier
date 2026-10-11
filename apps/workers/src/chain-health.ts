import {
  CHAINS,
  DEFAULT_THRESHOLDS,
  failedCriteria,
  nextListingState,
  type ChainHealthSnapshot,
  type ListingState,
  type ListingThresholds,
} from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';

export interface HealthSource {
  snapshot(chain: ChainKey): Promise<ChainHealthSnapshot>;
}

export interface ListingStore {
  get(chain: ChainKey): Promise<ListingState | undefined>;
  set(chain: ChainKey, state: ListingState): Promise<void>;
}

export interface ChainHealthResult {
  chain: ChainKey;
  status: ListingState['status'] | 'check-failed';
  failed: string[];
}

const INITIAL: ListingState = {
  status: 'listed',
  consecutiveFailingDays: 0,
  consecutivePassingDays: 0,
};

/**
 * Daily health check (spec section 5). A chain whose data cannot be fetched keeps
 * its previous state rather than counting as a failing day, so an outage in our
 * own data pipeline never delists a chain.
 */
export async function runChainHealthCheck(
  source: HealthSource,
  store: ListingStore,
  chains: readonly ChainKey[] = CHAINS.map((c) => c.key),
  thresholds: ListingThresholds = DEFAULT_THRESHOLDS,
): Promise<ChainHealthResult[]> {
  return Promise.all(
    chains.map(async (chain): Promise<ChainHealthResult> => {
      let snapshot: ChainHealthSnapshot;
      try {
        snapshot = await source.snapshot(chain);
      } catch {
        return { chain, status: 'check-failed', failed: [] };
      }
      const prev = (await store.get(chain)) ?? INITIAL;
      const next = nextListingState(prev, snapshot, thresholds);
      await store.set(chain, next);
      return { chain, status: next.status, failed: failedCriteria(snapshot, thresholds) };
    }),
  );
}

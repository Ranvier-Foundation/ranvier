import type { SwapHistory } from '../../ports/price-oracle.js';

/**
 * Stand-in until swap history is stored in Postgres: treats every wallet as a
 * returning wallet, so the first-swap promotion is never granted by mistake.
 */
export class AssumeReturningWallets implements SwapHistory {
  async hasCompletedSwap(): Promise<boolean> {
    return true;
  }
}

/**
 * PR 3 review, M1: the harness never follows the local-dev data onto another chain. With
 * `LOCAL_DEV_CHAIN_ID` (or the chain key) changed to anything but 31337, `pinned.ts`, and with it
 * the smoke, refuses to load, so no harness code runs at all.
 */
import type * as LocalDev from '@ranvier/chains/local-dev';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLocalDevChain,
  HARNESS_CHAIN_ID,
  HARNESS_CHAIN_KEY,
} from '../../src/harness/pinned.js';

describe('the harness runs on 31337 only, whatever local-dev says', () => {
  afterEach(() => {
    vi.doUnmock('@ranvier/chains/local-dev');
    vi.resetModules();
  });

  it('its own chain constants are the literals', () => {
    expect(HARNESS_CHAIN_ID).toBe(31337);
    expect(HARNESS_CHAIN_KEY).toBe('evm:31337');
  });

  it.each([
    [84532, 'evm:31337', 84532],
    [31337, 'evm:84532', 31337],
    [31337, 'evm:31337', 84532],
    [8453, 'evm:8453', 8453],
  ])('assertLocalDevChain(%s, %s, %s) throws', (id, key, field) => {
    expect(() => assertLocalDevChain(id, key, field)).toThrow('refuses to load');
  });

  it.each([
    ['LOCAL_DEV_CHAIN_ID', { LOCAL_DEV_CHAIN_ID: 84532 }],
    ['LOCAL_DEV_CHAIN_KEY', { LOCAL_DEV_CHAIN_KEY: 'evm:84532' }],
  ])('pinned.ts and smoke.ts refuse to load with %s moved to 84532', async (_name, patch) => {
    vi.resetModules();
    vi.doMock('@ranvier/chains/local-dev', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      ...patch,
    }));
    await expect(import('../../src/harness/pinned.js')).rejects.toThrow('refuses to load');
    await expect(import('./smoke.js')).rejects.toThrow('refuses to load');
  });

  it('LOCAL_DEV_CHAIN.chainId moved to 84532 is refused', async () => {
    vi.resetModules();
    vi.doMock('@ranvier/chains/local-dev', async (importOriginal) => {
      const orig = await importOriginal<typeof LocalDev>();
      return { ...orig, LOCAL_DEV_CHAIN: { ...orig.LOCAL_DEV_CHAIN, chainId: 84532 } };
    });
    await expect(import('../../src/harness/pinned.js')).rejects.toThrow('refuses to load');
  });
});

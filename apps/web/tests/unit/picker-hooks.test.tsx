import type { ChainKey } from '@ranvier/types';
import type * as ApiClient from '../../src/lib/api/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiBalances, ApiChain, ApiToken } from '../../src/lib/api/schemas';
import type { ChainBalances } from '../../src/lib/picker/model';
import { useBalances } from '../../src/lib/picker/use-balances';
import { useTokenPicker } from '../../src/lib/picker/use-token-picker';
import { renderHook } from './helpers/render-hook';

/**
 * The picker hooks, run for real with a stand-in API client whose answers the test releases by
 * hand, and which ignores the abort signal: an answer arrives even after the hook gave up on its
 * request, which is exactly what the guards in use-balances.ts and use-token-picker.ts exist for
 * (a response already read when the abort lands, a client that resolves anyway). The end-to-end
 * versions of these cases are in tests/e2e/token-picker.spec.ts.
 */

interface Pending<T> {
  args: unknown[];
  signal: AbortSignal;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const pending = vi.hoisted(() => ({
  balances: [] as Pending<unknown>[],
  tokens: [] as Pending<unknown>[],
  chains: [] as Pending<unknown>[],
}));

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  const ask = <T,>(list: Pending<unknown>[], args: unknown[], signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      list.push({ args, signal, resolve: resolve as (v: unknown) => void, reject });
    });
  return {
    ...actual,
    apiConfigured: () => true,
    fetchChains: (signal: AbortSignal) => ask(pending.chains, [], signal),
    fetchTokens: (chain: string, query: string, signal: AbortSignal) =>
      ask(pending.tokens, [chain, query], signal),
    fetchBalances: (chain: string, address: string, signal: AbortSignal) =>
      ask(pending.balances, [chain, address], signal),
  };
});

const WALLET_A = '0x7a3e1b2c9d4f5a60718293a4b5c6d7e8f9013f9c';
const WALLET_B = '0x1111111111111111111111111111111111112222';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const chain = (key: ChainKey, name: string, balances = true): ApiChain => ({
  key,
  name,
  family: 'evm',
  nativeSymbol: 'ETH',
  balances,
  quoting: true,
});
const ETHEREUM = chain('evm:1', 'Ethereum');
const BASE = chain('evm:8453', 'Base');
const token = (key: ChainKey, symbol: string): ApiToken => ({
  chain: key,
  address: symbol === 'ETH' ? 'native' : USDC,
  symbol,
  name: symbol,
  decimals: 18,
  tags: [],
});

const answer = (key: ChainKey, units: bigint): ApiBalances => ({
  chain: key,
  byAddress: new Map([[USDC, units]]),
});
const ready = (units: bigint): ChainBalances => ({
  status: 'ready',
  byAddress: new Map([[USDC, units]]),
});

beforeEach(() => {
  pending.balances.length = 0;
  pending.tokens.length = 0;
  pending.chains.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type BalanceProps = {
  address: string | undefined;
  targets: readonly ChainKey[];
  attempt: number;
};
const balancesHook = ({ address, targets, attempt }: BalanceProps) =>
  useBalances(address, [ETHEREUM, BASE], targets, attempt);

describe('useBalances: answers for a wallet, request or retry that is gone are dropped', () => {
  it('never returns the previous wallet balances, not even for the render in between', async () => {
    const run = await renderHook(balancesHook, {
      address: WALLET_A,
      targets: ['evm:1'],
      attempt: 0,
    });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(1));
    const [first] = pending.balances;
    first!.resolve(answer('evm:1', 5n));
    await vi.waitFor(() => expect(run.latest.get('evm:1')).toEqual(ready(5n)));

    await run.rerender({ address: WALLET_B, targets: ['evm:1'], attempt: 0 });
    // Every render made for wallet B, including the one before the reset effect ran, shows
    // nothing that belongs to wallet A.
    const forB = run.renders.filter((r) => r.props.address === WALLET_B);
    expect(forB.length).toBeGreaterThan(0);
    for (const r of forB) expect(r.result.get('evm:1')?.status).not.toBe('ready');
    await run.unmount();
  });

  it('a late answer for the previous wallet never reaches the new wallet, even if it is not aborted', async () => {
    // Abort does nothing here: only the wallet check in `set` stands between the old answer
    // and the new wallet's balances.
    vi.stubGlobal(
      'AbortController',
      class {
        readonly signal = new EventTarget() as unknown as AbortSignal;
        abort() {}
      },
    );
    const run = await renderHook(balancesHook, {
      address: WALLET_A,
      targets: ['evm:1'],
      attempt: 0,
    });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(1));
    await run.rerender({ address: WALLET_B, targets: ['evm:1'], attempt: 0 });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(2));
    expect(pending.balances[1]!.args).toEqual(['evm:1', WALLET_B]);

    pending.balances[0]!.resolve(answer('evm:1', 999n));
    await run.rerender({ address: WALLET_B, targets: ['evm:1'], attempt: 0 });
    expect(run.latest.get('evm:1')).toEqual({ status: 'loading' });
    // Wallet B's own answer still arrives normally.
    pending.balances[1]!.resolve(answer('evm:1', 7n));
    await vi.waitFor(() => expect(run.latest.get('evm:1')).toEqual(ready(7n)));
    await run.unmount();
  });

  it('a late answer of an aborted request is dropped after a retry', async () => {
    const run = await renderHook(balancesHook, {
      address: WALLET_A,
      targets: ['evm:1'],
      attempt: 0,
    });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(1));
    await run.rerender({ address: WALLET_A, targets: ['evm:1'], attempt: 1 });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(2));
    expect(pending.balances[0]!.signal.aborted).toBe(true);

    pending.balances[0]!.resolve(answer('evm:1', 999n));
    await run.rerender({ address: WALLET_A, targets: ['evm:1'], attempt: 1 });
    expect(run.latest.get('evm:1')).toEqual({ status: 'loading' });
    pending.balances[1]!.resolve(answer('evm:1', 7n));
    await vi.waitFor(() => expect(run.latest.get('evm:1')).toEqual(ready(7n)));
    await run.unmount();
  });

  it('a late answer is dropped after the wallet disconnects and the same wallet connects again', async () => {
    const run = await renderHook(balancesHook, {
      address: WALLET_A,
      targets: ['evm:1'],
      attempt: 0,
    });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(1));
    await run.rerender({ address: undefined, targets: ['evm:1'], attempt: 0 });
    expect(run.latest.size).toBe(0);
    await run.rerender({ address: WALLET_A, targets: ['evm:1'], attempt: 0 });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(2));

    pending.balances[0]!.resolve(answer('evm:1', 999n));
    await run.rerender({ address: WALLET_A, targets: ['evm:1'], attempt: 0 });
    expect(run.latest.get('evm:1')).toEqual({ status: 'loading' });
    await run.unmount();
  });

  it('a late answer for a chain that left the screen does not bring it back', async () => {
    const run = await renderHook(balancesHook, {
      address: WALLET_A,
      targets: ['evm:1', 'evm:8453'],
      attempt: 0,
    });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(2));
    await run.rerender({ address: WALLET_A, targets: ['evm:8453'], attempt: 0 });
    expect(run.latest.has('evm:1')).toBe(false);
    expect(pending.balances[0]!.args[0]).toBe('evm:1');
    expect(pending.balances[0]!.signal.aborted).toBe(true);

    pending.balances[0]!.resolve(answer('evm:1', 999n));
    await run.rerender({ address: WALLET_A, targets: ['evm:8453'], attempt: 0 });
    expect(run.latest.has('evm:1')).toBe(false);
    await run.unmount();
  });

  it('a late failure of an aborted request is not shown as an error', async () => {
    const run = await renderHook(balancesHook, {
      address: WALLET_A,
      targets: ['evm:1'],
      attempt: 0,
    });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(1));
    await run.rerender({ address: WALLET_A, targets: ['evm:1'], attempt: 1 });
    await vi.waitFor(() => expect(pending.balances).toHaveLength(2));

    pending.balances[0]!.reject(new Error('socket closed'));
    await run.rerender({ address: WALLET_A, targets: ['evm:1'], attempt: 1 });
    expect(run.latest.get('evm:1')).toEqual({ status: 'loading' });
    await run.unmount();
  });
});

describe('useTokenPicker: answers for a search, chain list or retry that is gone are dropped', () => {
  const list = (...symbols: string[]) => symbols.map((s) => token('evm:1', s));

  /** Renders the picker signed out, with the chain list answered (Ethereum only). */
  async function start() {
    const run = await renderHook((p: { wallet: string | undefined }) => useTokenPicker(p.wallet), {
      wallet: undefined,
    });
    await vi.waitFor(() => expect(pending.chains).toHaveLength(1));
    pending.chains[0]!.resolve([ETHEREUM]);
    await vi.waitFor(() => expect(pending.tokens).toHaveLength(1));
    return run;
  }

  it('a late answer of an older search never replaces the newer one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = await start();
    pending.tokens[0]!.resolve(list('ETH', 'USDC'));
    await vi.waitFor(() => expect(run.latest.tokens.status).toBe('ready'));

    // "usd" is sent after the pause; the user then moves on to "eth" before it answers.
    run.latest.setQuery('usd');
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(pending.tokens).toHaveLength(2));
    run.latest.setQuery('eth');
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(pending.tokens).toHaveLength(3));
    expect(pending.tokens.map((p) => p.args[1])).toEqual(['', 'usd', 'eth']);
    expect(pending.tokens[1]!.signal.aborted).toBe(true);

    pending.tokens[2]!.resolve(list('ETH'));
    await vi.waitFor(() =>
      expect(run.latest.tokens).toMatchObject({ tokens: [{ symbol: 'ETH' }] }),
    );
    pending.tokens[1]!.resolve(list('USDC'));
    await run.rerender({ wallet: undefined });
    expect(run.latest.tokens).toMatchObject({ status: 'ready', tokens: [{ symbol: 'ETH' }] });
    await run.unmount();
  });

  it('a late failure of an older search is not shown as an error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = await start();
    pending.tokens[0]!.resolve(list('ETH'));
    await vi.waitFor(() => expect(run.latest.tokens.status).toBe('ready'));
    run.latest.setQuery('usd');
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(pending.tokens).toHaveLength(2));
    run.latest.setQuery('eth');
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(pending.tokens).toHaveLength(3));
    pending.tokens[2]!.resolve(list('ETH'));
    await vi.waitFor(() => expect(run.latest.tokens.status).toBe('ready'));

    pending.tokens[1]!.reject(new Error('socket closed'));
    await run.rerender({ wallet: undefined });
    expect(run.latest.tokens.status).toBe('ready');
    await run.unmount();
  });

  it('a late chain list of an earlier try never replaces the newer one', async () => {
    const run = await renderHook((p: { wallet: string | undefined }) => useTokenPicker(p.wallet), {
      wallet: undefined,
    });
    await vi.waitFor(() => expect(pending.chains).toHaveLength(1));
    run.latest.retryChains();
    await vi.waitFor(() => expect(pending.chains).toHaveLength(2));
    expect(pending.chains[0]!.signal.aborted).toBe(true);

    pending.chains[1]!.resolve([ETHEREUM, BASE]);
    await vi.waitFor(() => expect(run.latest.chains.status).toBe('ready'));
    pending.chains[0]!.resolve([ETHEREUM]);
    await run.rerender({ wallet: undefined });
    expect(run.latest.chains).toMatchObject({
      status: 'ready',
      chains: [{ key: 'evm:1' }, { key: 'evm:8453' }],
    });
    await run.unmount();
  });

  it('a late chain list failure of an earlier try is not shown as an error', async () => {
    const run = await renderHook((p: { wallet: string | undefined }) => useTokenPicker(p.wallet), {
      wallet: undefined,
    });
    await vi.waitFor(() => expect(pending.chains).toHaveLength(1));
    run.latest.retryChains();
    await vi.waitFor(() => expect(pending.chains).toHaveLength(2));
    pending.chains[1]!.resolve([ETHEREUM]);
    await vi.waitFor(() => expect(run.latest.chains.status).toBe('ready'));

    pending.chains[0]!.reject(new Error('socket closed'));
    await run.rerender({ wallet: undefined });
    expect(run.latest.chains.status).toBe('ready');
    await run.unmount();
  });

  it('rows of the previous chain choice are never returned, not even for the render in between', async () => {
    const run = await renderHook((p: { wallet: string | undefined }) => useTokenPicker(p.wallet), {
      wallet: undefined,
    });
    await vi.waitFor(() => expect(pending.chains).toHaveLength(1));
    pending.chains[0]!.resolve([ETHEREUM, BASE]);
    await vi.waitFor(() => expect(pending.tokens).toHaveLength(2));
    pending.tokens[0]!.resolve(list('ETH'));
    pending.tokens[1]!.resolve([token('evm:8453', 'ETH')]);
    await vi.waitFor(() => expect(run.latest.tokens.status).toBe('ready'));

    run.latest.setSelection('evm:8453');
    await vi.waitFor(() => expect(pending.tokens).toHaveLength(3));
    expect(pending.tokens[2]!.args[0]).toBe('evm:8453');
    // Every render made for Base, including the one before the effect started its request, has
    // no rows of "all networks" in it.
    const forBase = run.renders.filter((r) => r.result.selection === 'evm:8453');
    expect(forBase.length).toBeGreaterThan(0);
    for (const r of forBase) expect(r.result.tokens.status).toBe('loading');

    pending.tokens[2]!.resolve([token('evm:8453', 'USDC')]);
    await vi.waitFor(() =>
      expect(run.latest.tokens).toMatchObject({ tokens: [{ chain: 'evm:8453', symbol: 'USDC' }] }),
    );
    await run.unmount();
  });
});

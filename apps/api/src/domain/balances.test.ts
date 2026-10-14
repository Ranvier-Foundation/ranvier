import { listTokens } from '@ranvier/chains';
import { describe, expect, it, vi } from 'vitest';
import {
  ChainReadError,
  type BalancesRead,
  type BalancesRequest,
  type ChainReader,
} from '../ports/chain-reader.js';
import { balanceChainIds, BalanceService, type BalanceServiceOptions } from './balances.js';

const OWNER = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const OTHER = '0x1111111111111111111111111111111111111111';

/** Lets queued microtasks (the concurrency limit's acquire) run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Pending {
  request: BalancesRequest;
  signal: AbortSignal;
  resolve: (read: BalancesRead) => void;
  reject: (err: unknown) => void;
}

/** A reader whose reads stay pending until the test settles them. */
class ManualReader implements ChainReader {
  readonly pending: Pending[] = [];
  readable = true;
  canRead(): boolean {
    return this.readable;
  }
  readBalances(request: BalancesRequest, signal: AbortSignal): Promise<BalancesRead> {
    return new Promise((resolve, reject) =>
      this.pending.push({ request, signal, resolve, reject }),
    );
  }
  /** The i-th read, once it has passed the concurrency limit (one macrotask later). */
  async read(i: number): Promise<Pending> {
    await settle();
    const p = this.pending[i];
    if (!p) throw new Error('no pending read');
    return p;
  }
  /** Settles the i-th read with a balance per token (index + 1). */
  async answer(i = 0, override: Partial<BalancesRead> = {}): Promise<void> {
    await settle();
    const p = this.pending[i];
    if (!p) throw new Error('no pending read');
    p.resolve({
      blockNumber: 100n,
      native: 42n,
      tokens: p.request.tokens.map((_t, j) => BigInt(j + 1)),
      ...override,
    });
  }
}

function service(opts: Partial<BalanceServiceOptions> = {}) {
  const reader = new ManualReader();
  let clock = 1_000_000;
  const svc = new BalanceService({
    reader,
    servedChainIds: [1, 8453, 42161, 84532],
    now: () => clock,
    ...opts,
  });
  return { reader, svc, tick: (ms: number) => (clock += ms) };
}

const never = () => new AbortController().signal;

async function rejection(p: Promise<unknown>): Promise<ChainReadError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChainReadError);
  return err as ChainReadError;
}

describe('balanceChainIds', () => {
  it('keeps served chains with a curated token list, once each', () => {
    expect(balanceChainIds([84532, 1, 8453, 1, 10])).toEqual([1, 8453]);
  });
});

describe('BalanceService', () => {
  it('serves only chains with a list, and is available only when the reader can read', () => {
    const { svc, reader } = service();
    expect(svc.serves('evm:1')).toBe(true);
    expect(svc.serves('evm:84532')).toBe(false);
    expect(svc.serves('solana:mainnet')).toBe(false);
    expect(svc.available(8453)).toBe(true);
    expect(svc.available(84532)).toBe(false);
    reader.readable = false;
    expect(svc.available(8453)).toBe(false);
  });

  it('returns the native coin and every listed token, in list order, from one read', async () => {
    const { svc, reader } = service();
    const p = svc.balances('evm:1', OWNER, never());
    await settle();
    expect(reader.pending).toHaveLength(1);
    const req = (await reader.read(0)).request;
    const list = listTokens('evm:1');
    expect(req).toEqual({
      chainId: 1,
      owner: OWNER,
      tokens: list.filter((t) => t.address !== 'native').map((t) => t.address),
    });
    await reader.answer(0, { tokens: req.tokens.map((_t, j) => (j === 1 ? null : BigInt(j + 1))) });
    const result = await p;
    expect(result.chain).toBe('evm:1');
    expect(result.address).toBe(OWNER);
    expect(result.blockNumber).toBe(100n);
    expect(result.balances.map((b) => b.address)).toEqual(list.map((t) => t.address));
    expect(result.balances[0]).toEqual({ address: 'native', balance: 42n });
    expect(result.balances[1]).toEqual({ address: req.tokens[0], balance: 1n });
    expect(result.balances[2]).toEqual({ address: req.tokens[1], balance: null });
  });

  it('answers a missing token result as null', async () => {
    const { svc, reader } = service();
    const p = svc.balances('evm:8453', OWNER, never());
    await reader.answer(0, { tokens: [] });
    const result = await p;
    expect(result.balances.slice(1).every((b) => b.balance === null)).toBe(true);
  });

  it('refuses a chain it does not serve', async () => {
    const { svc } = service();
    expect((await rejection(svc.balances('evm:84532', OWNER, never()))).reason).toBe(
      'chain_not_served',
    );
  });

  it('merges identical concurrent requests into one read', async () => {
    const { svc, reader } = service();
    const a = svc.balances('evm:1', OWNER, never());
    const b = svc.balances('evm:1', OWNER, never());
    const c = svc.balances('evm:8453', OWNER, never());
    await settle();
    expect(reader.pending).toHaveLength(2);
    await reader.answer(0);
    await reader.answer(1);
    const [ra, rb] = await Promise.all([a, b, c]);
    expect(ra).toBe(rb);
  });

  it('reuses a result for cacheTtlMs, then reads again', async () => {
    const { svc, reader, tick } = service({ cacheTtlMs: 3_000 });
    const first = svc.balances('evm:1', OWNER, never());
    await reader.answer(0);
    const r1 = await first;
    tick(2_999);
    expect(await svc.balances('evm:1', OWNER, never())).toBe(r1);
    await settle();
    expect(reader.pending).toHaveLength(1);
    tick(1);
    const again = svc.balances('evm:1', OWNER, never());
    await settle();
    expect(reader.pending).toHaveLength(2);
    await reader.answer(1);
    expect(await again).not.toBe(r1);
  });

  it('caches nothing with a TTL of 0', async () => {
    const { svc, reader } = service({ cacheTtlMs: 0 });
    const a = svc.balances('evm:1', OWNER, never());
    await reader.answer(0);
    await a;
    void svc.balances('evm:1', OWNER, never());
    await settle();
    expect(reader.pending).toHaveLength(2);
  });

  it('evicts the least recently used entry beyond maxCacheEntries', async () => {
    const { svc, reader } = service({ maxCacheEntries: 2 });
    const owners = [OWNER, OTHER, '0x2222222222222222222222222222222222222222'] as const;
    for (const [i, o] of owners.slice(0, 2).entries()) {
      const p = svc.balances('evm:1', o, never());
      await reader.answer(i);
      await p;
    }
    // Touch OWNER, so OTHER is the least recently used when the third arrives.
    await svc.balances('evm:1', OWNER, never());
    const third = svc.balances('evm:1', owners[2], never());
    await reader.answer(2);
    await third;
    await settle();
    expect(reader.pending).toHaveLength(3);
    await svc.balances('evm:1', OWNER, never());
    await settle();
    expect(reader.pending).toHaveLength(3);
    void svc.balances('evm:1', OTHER, never());
    await settle();
    expect(reader.pending).toHaveLength(4);
  });

  it('remembers a failure for failureTtlMs only', async () => {
    const { svc, reader, tick } = service({ failureTtlMs: 1_000 });
    const p = svc.balances('evm:1', OWNER, never());
    (await reader.read(0)).reject(new ChainReadError('rpc_unavailable', 'rpc_error'));
    expect((await rejection(p)).reason).toBe('rpc_error');
    expect((await rejection(svc.balances('evm:1', OWNER, never()))).reason).toBe('rpc_error');
    await settle();
    expect(reader.pending).toHaveLength(1);
    tick(1_000);
    void svc.balances('evm:1', OWNER, never());
    await settle();
    expect(reader.pending).toHaveLength(2);
  });

  it('does not cache an unexpected error, and passes it on', async () => {
    const { svc, reader } = service();
    const p = svc.balances('evm:1', OWNER, never());
    (await reader.read(0)).reject(new TypeError('bug'));
    await expect(p).rejects.toThrow(TypeError);
    void svc.balances('evm:1', OWNER, never());
    await settle();
    expect(reader.pending).toHaveLength(2);
  });

  it('wraps a non-Error rejection', async () => {
    const { svc, reader } = service();
    const p = svc.balances('evm:1', OWNER, never());
    (await reader.read(0)).reject('boom');
    await expect(p).rejects.toThrow('boom');
  });

  it('bounds reads per chain: beyond in-flight plus queue, fails fast and caches nothing', async () => {
    const { svc, reader } = service({ maxInFlightPerChain: 1, maxQueuePerChain: 0 });
    const first = svc.balances('evm:1', OWNER, never());
    const busy = await rejection(svc.balances('evm:1', OTHER, never()));
    expect([busy.code, busy.reason]).toEqual(['rpc_unavailable', 'busy']);
    // Another chain has its own limit.
    void svc.balances('evm:8453', OTHER, never());
    await vi.waitFor(() => expect(reader.pending).toHaveLength(2));
    await reader.answer(0);
    await first;
    // Not remembered: the next try reads.
    void svc.balances('evm:1', OTHER, never());
    await vi.waitFor(() => expect(reader.pending).toHaveLength(3));
  });

  it('gives a caller `timeout` when its signal aborts; the read goes on for others', async () => {
    const { svc, reader } = service();
    const impatient = new AbortController();
    const a = svc.balances('evm:1', OWNER, impatient.signal);
    const b = svc.balances('evm:1', OWNER, never());
    impatient.abort();
    expect((await rejection(a)).code).toBe('timeout');
    expect((await reader.read(0)).signal.aborted).toBe(false);
    await reader.answer(0);
    expect((await b).blockNumber).toBe(100n);
  });

  it('aborts the read once every caller has left, and starts afresh for the next one', async () => {
    const { svc, reader } = service();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const a = svc.balances('evm:1', OWNER, c1.signal);
    const b = svc.balances('evm:1', OWNER, c2.signal);
    c1.abort();
    c2.abort();
    await rejection(a);
    await rejection(b);
    expect((await reader.read(0)).signal.aborted).toBe(true);
    (await reader.read(0)).reject(new ChainReadError('timeout', 'deadline'));
    // Not remembered (abandoned), and not joined: a new read starts.
    const c = svc.balances('evm:1', OWNER, never());
    await settle();
    expect(reader.pending).toHaveLength(2);
    await reader.answer(1);
    expect((await c).blockNumber).toBe(100n);
  });

  it('refuses an already aborted signal', async () => {
    const { svc } = service();
    expect((await rejection(svc.balances('evm:1', OWNER, AbortSignal.abort()))).code).toBe(
      'timeout',
    );
  });

  it('gives every read its own deadline, independent of the callers', async () => {
    const { svc, reader } = service({ deadlineMs: 20 });
    const p = svc.balances('evm:1', OWNER, never());
    await vi.waitFor(async () => expect((await reader.read(0)).signal.aborted).toBe(true));
    (await reader.read(0)).reject(new ChainReadError('timeout', 'deadline'));
    expect((await rejection(p)).code).toBe('timeout');
  });
});

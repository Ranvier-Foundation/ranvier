import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConcurrencyLimit, ConcurrencyLimitError } from './concurrency-limit.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ConcurrencyLimit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('validates its options', () => {
    expect(() => new ConcurrencyLimit({ maxInFlight: 0, maxQueue: 0, maxWaitMs: 1 })).toThrow(
      'maxInFlight',
    );
    expect(() => new ConcurrencyLimit({ maxInFlight: 1.5, maxQueue: 0, maxWaitMs: 1 })).toThrow(
      'maxInFlight',
    );
    expect(() => new ConcurrencyLimit({ maxInFlight: 1, maxQueue: -1, maxWaitMs: 1 })).toThrow(
      'maxQueue',
    );
    expect(() => new ConcurrencyLimit({ maxInFlight: 1, maxQueue: 0.5, maxWaitMs: 1 })).toThrow(
      'maxQueue',
    );
    expect(() => new ConcurrencyLimit({ maxInFlight: 1, maxQueue: 0, maxWaitMs: 0 })).toThrow(
      'maxWaitMs',
    );
    expect(
      () => new ConcurrencyLimit({ maxInFlight: 1, maxQueue: 0, maxWaitMs: Number.NaN }),
    ).toThrow('maxWaitMs');
  });

  it('runs at most maxInFlight tasks, queues FIFO and fails fast beyond the queue', async () => {
    const limit = new ConcurrencyLimit({ maxInFlight: 2, maxQueue: 2, maxWaitMs: 10_000 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const order: number[] = [];
    const runs = gates.map((g, i) =>
      limit.run(async () => {
        order.push(i);
        await g.promise;
        return i;
      }),
    );
    await Promise.resolve();
    expect(limit.running).toBe(2);
    expect(limit.waiting).toBe(2);
    expect(order).toEqual([0, 1]);

    let started = false;
    await expect(
      limit.run(async () => {
        started = true;
      }),
    ).rejects.toBeInstanceOf(ConcurrencyLimitError);
    expect(started).toBe(false);

    gates[1]?.resolve();
    await expect(runs[1]).resolves.toBe(1);
    await vi.waitFor(() => expect(order).toEqual([0, 1, 2]));
    expect(limit.running).toBe(2);
    expect(limit.waiting).toBe(1);
    for (const g of gates) g.resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3]);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(limit.running).toBe(0);
    expect(limit.waiting).toBe(0);
  });

  it('with maxQueue 0, refuses as soon as every slot is busy', async () => {
    const limit = new ConcurrencyLimit({ maxInFlight: 1, maxQueue: 0, maxWaitMs: 1_000 });
    const gate = deferred();
    const first = limit.run(() => gate.promise);
    await expect(limit.run(async () => 1)).rejects.toThrow('concurrency limit reached');
    gate.resolve();
    await first;
    await expect(limit.run(async () => 2)).resolves.toBe(2);
  });

  it('times out a queued task and drops it from the queue', async () => {
    vi.useFakeTimers();
    const limit = new ConcurrencyLimit({ maxInFlight: 1, maxQueue: 5, maxWaitMs: 500 });
    const gate = deferred();
    const first = limit.run(() => gate.promise);
    let ran = false;
    const queued = limit.run(async () => {
      ran = true;
    });
    const assertion = expect(queued).rejects.toThrow('timed out waiting');
    expect(limit.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(limit.waiting).toBe(0);
    gate.resolve();
    await first;
    expect(ran).toBe(false);
    expect(limit.running).toBe(0);
  });

  it('releases the slot when a task throws', async () => {
    const limit = new ConcurrencyLimit({ maxInFlight: 1, maxQueue: 0, maxWaitMs: 1_000 });
    await expect(
      limit.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(limit.running).toBe(0);
    await expect(limit.run(async () => 'ok')).resolves.toBe('ok');
  });
});

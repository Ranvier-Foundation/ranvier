/** Thrown when the limit cannot take a task: the queue is full or the wait timed out. */
export class ConcurrencyLimitError extends Error {
  override readonly name = 'ConcurrencyLimitError';
}

export interface ConcurrencyLimitOptions {
  /** Tasks running at once. */
  maxInFlight: number;
  /** Tasks waiting for a slot; one more fails fast. 0 means no waiting at all. */
  maxQueue: number;
  /** Longest a task may wait for a slot before it fails. */
  maxWaitMs: number;
}

interface Waiter {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A small in-memory semaphore with a bounded FIFO queue. It keeps a flood of requests from
 * turning into thousands of parallel upstream calls (KMS has per-account request quotas):
 * beyond `maxInFlight + maxQueue` callers fail at once instead of piling up.
 */
export class ConcurrencyLimit {
  private inFlight = 0;
  /** FIFO: a Set iterates in insertion order, and deleting an absent waiter is a no-op. */
  private readonly queue = new Set<Waiter>();

  constructor(private readonly opts: ConcurrencyLimitOptions) {
    const { maxInFlight, maxQueue, maxWaitMs } = opts;
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error('maxInFlight must be a positive integer');
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new Error('maxQueue must be a non-negative integer');
    }
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) throw new Error('maxWaitMs must be > 0');
  }

  get running(): number {
    return this.inFlight;
  }

  get waiting(): number {
    return this.queue.size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.opts.maxInFlight) {
      this.inFlight++;
      return Promise.resolve();
    }
    if (this.queue.size >= this.opts.maxQueue) {
      return Promise.reject(new ConcurrencyLimitError('concurrency limit reached'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          this.queue.delete(waiter);
          reject(new ConcurrencyLimitError('timed out waiting for a concurrency slot'));
        }, this.opts.maxWaitMs),
      };
      this.queue.add(waiter);
    });
  }

  private release(): void {
    const next = this.queue.values().next();
    // The slot passes straight to the next waiter, so `inFlight` is unchanged.
    if (next.done) {
      this.inFlight--;
    } else {
      this.queue.delete(next.value);
      next.value.start();
    }
  }
}

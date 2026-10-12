import { describe, expect, it } from 'vitest';
import type { ProviderQuote, QuoteRequest } from '@ranvier/types';
import { ProviderError } from '../ports/provider-error.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import { compareProviderQuotes, compareQuotes, failureCode } from './orchestrator.js';
import { UnsafeRouteError } from './route-safety.js';

const req: QuoteRequest = {
  sellToken: { chain: 'evm:1', address: 'native' },
  buyToken: { chain: 'evm:1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  sellAmount: 10n ** 18n,
  taker: '0x0000000000000000000000000000000000000001',
  slippageBps: 50,
};

function quote(
  provider: string,
  buyAmountUsd: bigint,
  gasCostUsd: bigint,
  buyAmount = buyAmountUsd,
): ProviderQuote {
  return {
    provider,
    buyAmount,
    minBuyAmount: buyAmount,
    buyAmountUsd,
    gasCostUsd,
    route: [],
    tx: { to: '0x', data: '0x', value: 0n },
  };
}

function provider(
  name: string,
  run: (signal: AbortSignal) => Promise<ProviderQuote>,
  supports = true,
): QuoteProvider {
  return { name, supports: () => supports, quote: (_r, signal) => run(signal) };
}

const accept = (q: ProviderQuote): ProviderQuote => q;

describe('compareProviderQuotes', () => {
  it('picks the best net output, not the best gross output', async () => {
    const result = await compareProviderQuotes(
      [
        provider('gross', async () => quote('gross', 1000n, 300n)),
        provider('net', async () => quote('net', 900n, 50n)),
      ],
      req,
      { timeoutMs: 100, vet: accept },
    );
    expect(result.best?.provider).toBe('net');
    expect(result.quotes.map((q) => q.provider)).toEqual(['net', 'gross']);
  });

  it('isolates failures and timeouts', async () => {
    let aborted = false;
    const logged: [string, unknown][] = [];
    const result = await compareProviderQuotes(
      [
        provider('ok', async () => quote('ok', 100n, 1n)),
        provider('broken', async () => {
          throw new Error('boom');
        }),
        provider('rejects-non-error', () => Promise.reject('nope')),
        provider('slow', (signal) => {
          signal.addEventListener('abort', () => (aborted = true));
          return new Promise(() => {});
        }),
      ],
      req,
      { timeoutMs: 20, vet: accept, onFailure: (f, err) => logged.push([f.provider, err]) },
    );
    expect(result.best?.provider).toBe('ok');
    // Clients get stable codes only: no upstream message is copied into the result.
    expect(result.failures).toEqual([
      { provider: 'broken', error: 'upstream_error' },
      { provider: 'rejects-non-error', error: 'upstream_error' },
      { provider: 'slow', error: 'timeout' },
    ]);
    expect(JSON.stringify(result.failures)).not.toContain('boom');
    // The detail is still available to the server log.
    expect(logged.map(([p]) => p)).toEqual(['broken', 'rejects-non-error', 'slow']);
    expect((logged[0]![1] as Error).message).toBe('boom');
    expect(aborted).toBe(true);
  });

  it('skips providers that do not support the request', async () => {
    const result = await compareProviderQuotes(
      [provider('no', async () => quote('no', 1n, 0n), false)],
      req,
      { timeoutMs: 10, vet: accept },
    );
    expect(result).toEqual({ best: undefined, quotes: [], failures: [] });
  });

  it('refuses quotes the vetting step rejects, with a stable code', async () => {
    const result = await compareProviderQuotes(
      [
        provider('unsafe', async () => quote('unsafe', 100n, 0n)),
        provider('safe', async () => quote('safe', 50n, 0n)),
      ],
      req,
      {
        timeoutMs: 10,
        vet: (q) => {
          if (q.provider === 'unsafe') throw new UnsafeRouteError('unknown_target');
          return q;
        },
      },
    );
    expect(result.best?.provider).toBe('safe');
    expect(result.failures).toEqual([{ provider: 'unsafe', error: 'rejected_unsafe_route' }]);
  });

  it('passes provider error codes through', async () => {
    const result = await compareProviderQuotes(
      [
        provider('dry', async () => Promise.reject(new ProviderError('no_liquidity', 'x'))),
        provider('bad', async () => Promise.reject(new ProviderError('invalid_response', 'y'))),
      ],
      req,
      { timeoutMs: 10, vet: accept },
    );
    expect(result.failures).toEqual([
      { provider: 'dry', error: 'no_liquidity' },
      { provider: 'bad', error: 'invalid_response' },
    ]);
  });
});

describe('failureCode', () => {
  it('maps unknown errors to upstream_error', () => {
    expect(failureCode(new Error('secret detail'))).toBe('upstream_error');
    expect(failureCode('string')).toBe('upstream_error');
  });
});

describe('compareQuotes', () => {
  it('breaks net ties by output amount, then by provider name', () => {
    expect(compareQuotes(quote('a', 100n, 0n, 5n), quote('b', 100n, 0n, 6n))).toBe(1);
    expect(compareQuotes(quote('a', 100n, 0n, 6n), quote('b', 100n, 0n, 5n))).toBe(-1);
    expect(compareQuotes(quote('a', 100n, 0n), quote('b', 100n, 0n))).toBeLessThan(0);
  });
});

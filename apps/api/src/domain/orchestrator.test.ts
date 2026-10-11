import { describe, expect, it } from 'vitest';
import type { ProviderQuote, QuoteRequest } from '@ranvier/types';
import type { QuoteProvider } from '../ports/quote-provider.js';
import { compareProviderQuotes, compareQuotes } from './orchestrator.js';

const req: QuoteRequest = {
  sellToken: { chain: 'evm:1', address: 'native', symbol: 'ETH', decimals: 18 },
  buyToken: {
    chain: 'evm:1',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
    decimals: 6,
  },
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

describe('compareProviderQuotes', () => {
  it('picks the best net output, not the best gross output', async () => {
    const result = await compareProviderQuotes(
      [
        provider('gross', async () => quote('gross', 1000n, 300n)),
        provider('net', async () => quote('net', 900n, 50n)),
      ],
      req,
      { timeoutMs: 100 },
    );
    expect(result.best?.provider).toBe('net');
    expect(result.quotes.map((q) => q.provider)).toEqual(['net', 'gross']);
  });

  it('isolates failures and timeouts', async () => {
    let aborted = false;
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
      { timeoutMs: 20 },
    );
    expect(result.best?.provider).toBe('ok');
    expect(result.failures).toEqual([
      { provider: 'broken', error: 'error', message: 'boom' },
      { provider: 'rejects-non-error', error: 'error', message: 'nope' },
      { provider: 'slow', error: 'timeout', message: 'timed out after 20ms' },
    ]);
    expect(aborted).toBe(true);
  });

  it('skips providers that do not support the request', async () => {
    const result = await compareProviderQuotes(
      [provider('no', async () => quote('no', 1n, 0n), false)],
      req,
      { timeoutMs: 10 },
    );
    expect(result).toEqual({ best: undefined, quotes: [], failures: [] });
  });

  it('rejects quotes whose minimum exceeds their output', async () => {
    const bad = { ...quote('bad', 100n, 0n), minBuyAmount: 101n };
    const result = await compareProviderQuotes([provider('bad', async () => bad)], req, {
      timeoutMs: 10,
    });
    expect(result.best).toBeUndefined();
    expect(result.failures[0]?.message).toBe('minBuyAmount exceeds buyAmount');
  });
});

describe('compareQuotes', () => {
  it('breaks net ties by output amount, then by provider name', () => {
    expect(compareQuotes(quote('a', 100n, 0n, 5n), quote('b', 100n, 0n, 6n))).toBe(1);
    expect(compareQuotes(quote('a', 100n, 0n, 6n), quote('b', 100n, 0n, 5n))).toBe(-1);
    expect(compareQuotes(quote('a', 100n, 0n), quote('b', 100n, 0n))).toBeLessThan(0);
  });
});

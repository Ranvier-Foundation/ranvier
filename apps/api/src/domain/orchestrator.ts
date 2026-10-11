import type { ProviderQuote, QuoteRequest } from '@ranvier/types';
import type { QuoteProvider } from '../ports/quote-provider.js';

export interface ProviderFailure {
  provider: string;
  error: 'timeout' | 'error';
  message: string;
}

export interface QuoteComparison {
  best: ProviderQuote | undefined;
  /** All successful quotes, best first. */
  quotes: ProviderQuote[];
  failures: ProviderFailure[];
}

/** Net value to the user: output value minus the gas they pay. */
export function netValue(q: ProviderQuote): bigint {
  return q.buyAmountUsd - q.gasCostUsd;
}

export function compareQuotes(a: ProviderQuote, b: ProviderQuote): number {
  const byNet = netValue(b) - netValue(a);
  if (byNet !== 0n) return byNet > 0n ? 1 : -1;
  const byAmount = b.buyAmount - a.buyAmount;
  if (byAmount !== 0n) return byAmount > 0n ? 1 : -1;
  return a.provider.localeCompare(b.provider);
}

class ProviderTimeout extends Error {}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeout(`timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Queries every supporting provider in parallel and ranks by net output.
 * One slow or failing provider never blocks or breaks the result (spec section 9).
 */
export async function compareProviderQuotes(
  providers: readonly QuoteProvider[],
  req: QuoteRequest,
  opts: { timeoutMs: number },
): Promise<QuoteComparison> {
  const eligible = providers.filter((p) => p.supports(req));
  const results = await Promise.all(
    eligible.map(async (p) => {
      try {
        return {
          provider: p.name,
          quote: await withTimeout((signal) => p.quote(req, signal), opts.timeoutMs),
        };
      } catch (err: unknown) {
        return { provider: p.name, err };
      }
    }),
  );

  const quotes: ProviderQuote[] = [];
  const failures: ProviderFailure[] = [];
  for (const r of results) {
    if ('quote' in r) {
      if (r.quote.minBuyAmount > r.quote.buyAmount) {
        failures.push({
          provider: r.provider,
          error: 'error',
          message: 'minBuyAmount exceeds buyAmount',
        });
      } else {
        quotes.push(r.quote);
      }
    } else {
      failures.push({
        provider: r.provider,
        error: r.err instanceof ProviderTimeout ? 'timeout' : 'error',
        message: r.err instanceof Error ? r.err.message : String(r.err),
      });
    }
  }

  quotes.sort(compareQuotes);
  return { best: quotes[0], quotes, failures };
}

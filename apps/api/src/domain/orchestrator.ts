import type { ProviderQuote, QuoteRequest } from '@ranvier/types';
import { ProviderError, type FailureCode } from '../ports/provider-error.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import { UnsafeRouteError } from './route-safety.js';

/** What a client learns about a failed provider: its name and a stable code, nothing more. */
export interface ProviderFailure {
  provider: string;
  error: FailureCode;
}

export interface QuoteComparison<Q extends ProviderQuote = ProviderQuote> {
  best: Q | undefined;
  /** All successful quotes, best first. */
  quotes: Q[];
  failures: ProviderFailure[];
}

export interface CompareOptions<Q extends ProviderQuote> {
  timeoutMs: number;
  /** Checks a quote before it can be ranked or offered; throws to refuse it. */
  vet: (quote: ProviderQuote) => Q;
  /** Server-side record of the detail behind each failure (never sent to clients). */
  onFailure?: (failure: ProviderFailure, err: unknown) => void;
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

class ProviderTimeout extends Error {
  override readonly name = 'ProviderTimeout';
}

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

/** Maps any provider or vetting error to a stable client-facing code. */
export function failureCode(err: unknown): FailureCode {
  if (err instanceof ProviderTimeout) return 'timeout';
  if (err instanceof UnsafeRouteError) return 'rejected_unsafe_route';
  if (err instanceof ProviderError) return err.code;
  return 'upstream_error';
}

/**
 * Queries every supporting provider in parallel, vets each quote, and ranks the survivors
 * by net output. One slow, failing or unsafe provider never blocks or breaks the result.
 */
export async function compareProviderQuotes<Q extends ProviderQuote>(
  providers: readonly QuoteProvider[],
  req: QuoteRequest,
  opts: CompareOptions<Q>,
): Promise<QuoteComparison<Q>> {
  const eligible = providers.filter((p) => p.supports(req));
  const results = await Promise.all(
    eligible.map(async (p) => {
      try {
        const quote = await withTimeout((signal) => p.quote(req, signal), opts.timeoutMs);
        return { provider: p.name, quote: opts.vet(quote) };
      } catch (err: unknown) {
        return { provider: p.name, err };
      }
    }),
  );

  const quotes: Q[] = [];
  const failures: ProviderFailure[] = [];
  for (const r of results) {
    if ('quote' in r) {
      quotes.push(r.quote);
    } else {
      const failure = { provider: r.provider, error: failureCode(r.err) };
      failures.push(failure);
      opts.onFailure?.(failure, r.err);
    }
  }

  quotes.sort(compareQuotes);
  return { best: quotes[0], quotes, failures };
}

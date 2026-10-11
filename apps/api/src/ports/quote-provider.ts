import type { ProviderQuote, QuoteRequest } from '@ranvier/types';

/** A routing provider (0x, 1inch, LI.FI, Jupiter, ...) behind a common interface. */
export interface QuoteProvider {
  readonly name: string;
  supports(req: QuoteRequest): boolean;
  /** Must honour `signal` so a slow provider can be abandoned. */
  quote(req: QuoteRequest, signal: AbortSignal): Promise<ProviderQuote>;
}

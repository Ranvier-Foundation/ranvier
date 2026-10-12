/**
 * Stable failure codes returned to clients. Upstream details (messages, bodies, calldata)
 * are logged server-side only.
 */
export type FailureCode =
  'timeout' | 'no_liquidity' | 'upstream_error' | 'invalid_response' | 'rejected_unsafe_route';

/** A provider failure with a stable code; `message` is for server logs, never clients. */
export class ProviderError extends Error {
  constructor(
    readonly code: Exclude<FailureCode, 'timeout' | 'rejected_unsafe_route'>,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

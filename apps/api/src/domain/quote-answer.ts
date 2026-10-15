import type { QuoteRequest, QuoteTimingEcho } from '@ranvier/types';
import { sameChainEvmContext, type QuoteChainContext, type SignedSwap } from './swap-quote.js';

/**
 * When a signed quote was made and how long it lives (ADR 0012). `serverTime` is the reading of
 * the server clock (unix seconds) that the signed deadline is computed from, so
 * `deadline == serverTime + ttlSeconds` always holds. The deadline stays authoritative: these two
 * only let a client count the remaining time without trusting its own wall clock.
 */
export type QuoteTiming = QuoteTimingEcho;

/** Top-level fields of a signed swap answer, besides `fee`, `best`, `quotes`, `failures`, `swap`. */
export type SignedAnswerEcho = QuoteChainContext & QuoteTiming;

/** The echoed fields disagree with what was signed: a server bug, never a client error. */
export class QuoteEchoMismatchError extends Error {
  constructor(field: string) {
    super(`quote answer echo disagrees with the signed quote: ${field}`);
    this.name = 'QuoteEchoMismatchError';
  }
}

function isUnixSeconds(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** The signed deadline for `timing`: the one formula the API signs with. */
export function signedDeadline(timing: QuoteTiming): bigint {
  if (!isUnixSeconds(timing.serverTime)) throw new QuoteEchoMismatchError('serverTime');
  if (!isUnixSeconds(timing.ttlSeconds)) throw new QuoteEchoMismatchError('ttlSeconds');
  return BigInt(timing.serverTime) + BigInt(timing.ttlSeconds);
}

function sameContext(a: QuoteChainContext, b: QuoteChainContext): boolean {
  return a.sellChain === b.sellChain && a.buyChain === b.buyChain && a.chainId === b.chainId;
}

/**
 * The chain and timing echo of a signed swap answer. The chain is the context `buildSignedSwap`
 * passed to the EIP-712 domain, and the timing is the reading the deadline was computed from;
 * nothing comes from provider output. Each value is checked against the signed quote and the
 * validated request before it is sent, so the answer cannot name a chain or a lifetime other
 * than the one signed: a mismatch throws (500 `internal_error`), it is never repaired.
 */
export function signedAnswerEcho(
  request: Pick<QuoteRequest, 'sellToken' | 'buyToken'>,
  swap: Pick<SignedSwap, 'quote' | 'context'>,
  timing: QuoteTiming,
): SignedAnswerEcho {
  const expected = sameChainEvmContext(request);
  if (!expected || !sameContext(expected, swap.context)) {
    throw new QuoteEchoMismatchError('chain');
  }
  if (swap.quote.deadline !== signedDeadline(timing)) throw new QuoteEchoMismatchError('deadline');
  const { sellChain, buyChain, chainId } = swap.context;
  return {
    sellChain,
    buyChain,
    chainId,
    serverTime: timing.serverTime,
    ttlSeconds: timing.ttlSeconds,
  };
}

/**
 * The chain echo of a direct wrap or unwrap answer: the validated request's chain. A direct wrap
 * is same-chain EVM by construction (`buildDirectWrap`); anything else throws.
 */
export function directAnswerEcho(
  request: Pick<QuoteRequest, 'sellToken' | 'buyToken'>,
): QuoteChainContext {
  const context = sameChainEvmContext(request);
  if (!context) throw new QuoteEchoMismatchError('chain');
  return context;
}

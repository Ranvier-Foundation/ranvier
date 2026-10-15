import { FEE_SCHEDULE, feeAmount } from '@ranvier/fees';
import type { FeeReason, TokenRef } from '@ranvier/types';
import { list, record, SchemaError, text, type Json } from './schemas';

/**
 * `POST /v1/quotes`, parsed for display only (ADR 0011).
 *
 * The answer is read from `unknown` field by field and copied into a small typed value: only what
 * the screen shows, plus what is needed to check that the answer is the one asked for. Everything
 * else the API sends is never read, never copied and so never kept: the router `tx` and calldata,
 * the signature, the signed `swap.transaction`, the nonce, the router address, the route's hops,
 * the other providers' quotes and the failures. A later change that signs a swap fetches and
 * reviews those on its own; nothing here can leak them to a log, a store or the DOM.
 * A response that does not match exactly is refused whole, never repaired or partly shown.
 */

export type QuoteFee = {
  /** Rate in basis points, from the schedule (never above the contract cap). */
  bps: number;
  reason: FeeReason;
  /** Fee in sell-token base units: the exact amount the quote carries. */
  amount: bigint;
  /** First-swap waiver in USD cents (0 when none applies). */
  waivedUsdCents: bigint;
};

export type SwapQuote = {
  kind: 'swap';
  /** What the route delivers, net of the Ranvier fee, in buy-token base units. */
  buyAmount: bigint;
  /** The signed floor: the least this quote allows. */
  minBuyAmount: bigint;
  buyUsdCents: bigint;
  /** Estimated network cost in USD cents. */
  networkCostUsdCents: bigint;
  /** Provider name from the API, rendered as text only. */
  provider: string;
  /** How many routes were compared (successful, vetted quotes). */
  routeCount: number;
  fee: QuoteFee;
  /** Absolute expiry as the server wrote it: unix seconds. */
  deadlineSec: number;
};

export type WrapQuote = {
  kind: 'wrap';
  direction: 'wrap' | 'unwrap';
  /** Always equal to the sell amount (1:1). */
  buyAmount: bigint;
  minBuyAmount: bigint;
  fee: QuoteFee;
};

export type ApiQuote = SwapQuote | WrapQuote;

/** What was asked, which the answer must echo. */
export interface QuoteAsk {
  sellToken: TokenRef;
  buyToken: TokenRef;
  /** Sell amount before the fee, in base units. */
  sellAmount: bigint;
  taker: string;
  slippageBps: number;
}

const UINT = /^(?:0|[1-9]\d{0,77})$/;
const MAX_UINT256 = 2n ** 256n - 1n;
const EVM_ADDRESS_ANY_CASE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_QUOTES = 16;
/** Longest provider name shown. */
const MAX_PROVIDER_CHARS = 32;

const FEE_REASONS: ReadonlySet<string> = new Set<FeeReason>([
  'wrap-unwrap',
  'first-swap-promo',
  'stablecoin',
  'tier-under-10k',
  'tier-10k-100k',
  'tier-over-100k',
]);

/** A base-unit amount sent as a decimal string, up to uint256. */
function units(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || !UINT.test(value)) throw new SchemaError(path);
  const n = BigInt(value);
  if (n > MAX_UINT256) throw new SchemaError(path);
  return n;
}

/** The rates a fee reason may carry: the schedule, nothing else. */
function allowedBps(reason: FeeReason): readonly number[] {
  switch (reason) {
    case 'wrap-unwrap':
      return [FEE_SCHEDULE.wrapUnwrapBps];
    case 'stablecoin':
      return [FEE_SCHEDULE.stablecoinBps];
    case 'tier-under-10k':
      return [FEE_SCHEDULE.tier1.bps];
    case 'tier-10k-100k':
      return [FEE_SCHEDULE.tier2.bps];
    case 'tier-over-100k':
      return [FEE_SCHEDULE.tier3.bps];
    case 'first-swap-promo':
      // The waiver keeps the rate the swap would otherwise pay.
      return [
        FEE_SCHEDULE.tier1.bps,
        FEE_SCHEDULE.tier2.bps,
        FEE_SCHEDULE.tier3.bps,
        FEE_SCHEDULE.stablecoinBps,
      ];
  }
}

/**
 * The fee must be one the schedule can produce for the amount that was sold: a rate on the
 * schedule and under the contract cap, and the amount the rate gives (or less, for a first-swap
 * waiver). A fee outside the schedule is refused, not displayed.
 */
function parseFee(value: unknown, sellAmount: bigint): QuoteFee {
  const o = record(value, 'fee');
  const bps = o['bps'];
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > FEE_SCHEDULE.maxBps) {
    throw new SchemaError('fee.bps');
  }
  const reason = o['reason'];
  if (typeof reason !== 'string' || !FEE_REASONS.has(reason)) throw new SchemaError('fee.reason');
  const known = reason as FeeReason;
  if (!allowedBps(known).includes(bps)) throw new SchemaError('fee.bps');
  const amount = units(o['amount'], 'fee.amount');
  const waivedUsdCents = units(o['waivedUsd'], 'fee.waivedUsd');
  const full = feeAmount(sellAmount, bps);
  if (known === 'first-swap-promo') {
    if (waivedUsdCents === 0n || waivedUsdCents > FEE_SCHEDULE.firstSwapFreeUsd) {
      throw new SchemaError('fee.waivedUsd');
    }
    if (amount > full) throw new SchemaError('fee.amount');
  } else {
    if (waivedUsdCents !== 0n) throw new SchemaError('fee.waivedUsd');
    if (amount !== full) throw new SchemaError('fee.amount');
  }
  return { bps, reason: known, amount, waivedUsdCents };
}

function address(value: unknown, path: string): string {
  if (typeof value !== 'string' || !EVM_ADDRESS_ANY_CASE.test(value)) throw new SchemaError(path);
  return value.toLowerCase();
}

function parseDirect(o: Json, ask: QuoteAsk, fee: QuoteFee): WrapQuote {
  const d = record(o['direct'], 'direct');
  const kind = d['kind'];
  if (kind !== 'wrap' && kind !== 'unwrap') throw new SchemaError('direct.kind');
  // Selling the native coin is a wrap, selling the wrapped token an unwrap (1:1, no router).
  if (kind !== (ask.sellToken.address === 'native' ? 'wrap' : 'unwrap')) {
    throw new SchemaError('direct.kind');
  }
  const buyAmount = units(d['buyAmount'], 'direct.buyAmount');
  const minBuyAmount = units(d['minBuyAmount'], 'direct.minBuyAmount');
  if (buyAmount !== ask.sellAmount || minBuyAmount !== ask.sellAmount) {
    throw new SchemaError('direct.buyAmount');
  }
  if (fee.reason !== 'wrap-unwrap' || fee.amount !== 0n || fee.bps !== 0) {
    throw new SchemaError('fee');
  }
  return { kind: 'wrap', direction: kind, buyAmount, minBuyAmount, fee };
}

function parseSwap(o: Json, ask: QuoteAsk, fee: QuoteFee): SwapQuote {
  if (fee.reason === 'wrap-unwrap') throw new SchemaError('fee.reason');
  const best = record(o['best'], 'best');
  const provider = text(best['provider'], 'best.provider', MAX_PROVIDER_CHARS);
  const buyAmount = units(best['buyAmount'], 'best.buyAmount');
  const minBuyAmount = units(best['minBuyAmount'], 'best.minBuyAmount');
  if (buyAmount === 0n || minBuyAmount === 0n || minBuyAmount > buyAmount) {
    throw new SchemaError('best.minBuyAmount');
  }
  const buyUsdCents = units(best['buyAmountUsd'], 'best.buyAmountUsd');
  const networkCostUsdCents = units(best['gasCostUsd'], 'best.gasCostUsd');
  const routeCount = list(o['quotes'], 'quotes', MAX_QUOTES).length;
  if (routeCount === 0) throw new SchemaError('quotes');

  // The signed quote is read only to check that it is the one asked for, and for its expiry.
  const signed = record(record(o['swap'], 'swap')['quote'], 'swap.quote');
  if (address(signed['user'], 'swap.quote.user') !== ask.taker.toLowerCase()) {
    throw new SchemaError('swap.quote.user');
  }
  const wants = (t: TokenRef) => (t.address === 'native' ? ZERO_ADDRESS : t.address.toLowerCase());
  if (address(signed['tokenIn'], 'swap.quote.tokenIn') !== wants(ask.sellToken)) {
    throw new SchemaError('swap.quote.tokenIn');
  }
  if (address(signed['tokenOut'], 'swap.quote.tokenOut') !== wants(ask.buyToken)) {
    throw new SchemaError('swap.quote.tokenOut');
  }
  if (units(signed['amountIn'], 'swap.quote.amountIn') !== ask.sellAmount) {
    throw new SchemaError('swap.quote.amountIn');
  }
  // The fee shown is the fee signed, and the minimum shown is the signed floor.
  if (units(signed['feeAmount'], 'swap.quote.feeAmount') !== fee.amount) {
    throw new SchemaError('swap.quote.feeAmount');
  }
  if (units(signed['minAmountOut'], 'swap.quote.minAmountOut') !== minBuyAmount) {
    throw new SchemaError('swap.quote.minAmountOut');
  }
  const deadline = signed['deadline'];
  if (typeof deadline !== 'string' || !/^[1-9]\d{0,14}$/.test(deadline)) {
    throw new SchemaError('swap.quote.deadline');
  }
  return {
    kind: 'swap',
    buyAmount,
    minBuyAmount,
    buyUsdCents,
    networkCostUsdCents,
    provider,
    routeCount,
    fee,
    deadlineSec: Number(deadline),
  };
}

/**
 * Parses the answer to the request `ask`. It must be exactly one of a routed swap (with the signed
 * fee quote) or a direct wrap/unwrap, and it must echo the taker, the tokens and the sell amount
 * (the API's answer carries no chain keys, so the chain is bound by pairing this answer with its
 * own request: one request, one answer, late answers dropped by the caller).
 */
export function parseQuote(json: unknown, ask: QuoteAsk): ApiQuote {
  const o = record(json, '(body)');
  const fee = parseFee(o['fee'], ask.sellAmount);
  const direct = o['direct'] !== undefined;
  const swap = o['swap'] !== undefined;
  // Neither is an unsigned quote (the API has no signer): there is no fee to trust, so no quote.
  if (direct === swap) throw new SchemaError(direct ? '(direct and swap)' : '(swap)');
  return direct ? parseDirect(o, ask, fee) : parseSwap(o, ask, fee);
}

/** Error codes the quote endpoint sends (ADR 0004), plus `routing_slow` derived from `no_route`. */
export type QuoteErrorCode =
  | 'invalid_request'
  | 'no_route'
  | 'routing_slow'
  | 'price_unavailable'
  | 'routing_unavailable'
  | 'signing_unavailable'
  | 'internal_error';

const ERROR_CODES: ReadonlySet<string> = new Set<QuoteErrorCode>([
  'invalid_request',
  'no_route',
  'price_unavailable',
  'routing_unavailable',
  'signing_unavailable',
  'internal_error',
]);
const SLOW_FAILURES: ReadonlySet<string> = new Set(['timeout', 'upstream_error', 'invalid_response']);

/**
 * The stable code of an error answer, or `undefined`. Only a closed set is accepted; any text the
 * API sends (a `message`, provider names) is ignored. A `no_route` whose every provider failed
 * with a timeout or an upstream error is `routing_slow`: the route may exist, the providers did
 * not answer, so the advice is to try again rather than to change the amount.
 */
export function parseQuoteError(json: unknown): QuoteErrorCode | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const o = json as Json;
  const code = o['error'];
  if (typeof code !== 'string' || !ERROR_CODES.has(code)) return undefined;
  if (code !== 'no_route') return code as QuoteErrorCode;
  const failures = o['failures'];
  if (Array.isArray(failures) && failures.length > 0 && failures.length <= MAX_QUOTES) {
    const allSlow = failures.every((f: unknown) => {
      const e = typeof f === 'object' && f !== null ? (f as Json)['error'] : undefined;
      return typeof e === 'string' && SLOW_FAILURES.has(e);
    });
    if (allSlow) return 'routing_slow';
  }
  return 'no_route';
}

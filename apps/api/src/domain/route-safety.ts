import { NATIVE } from '@ranvier/chains';
import type { ProviderQuote, QuoteRequest } from '@ranvier/types';
import type { Hex } from 'viem';
import type { TokenPrice } from '../ports/price-oracle.js';
import {
  decodeAllowanceHolderExec,
  decodeSettlerExecute,
  type AllowanceHolderExec,
  type SettlerExecute,
  ZEROX_NATIVE_IN,
  ZEROX_NATIVE_OUT,
} from './allowance-holder.js';
import { trustedRouter, type RoutePolicy, type TrustedRouter } from './route-policy.js';
import { usdE18 } from './usd.js';

const BPS = 10_000n;

/** Why a route was refused. Logged server-side; clients only see `rejected_unsafe_route`. */
export type UnsafeRouteReason =
  | 'unsupported_chain'
  | 'unknown_router'
  | 'malformed_calldata'
  | 'operator_not_target'
  | 'unknown_target'
  | 'wrong_input_token'
  | 'wrong_input_amount'
  | 'wrong_recipient'
  | 'wrong_output_token'
  | 'calldata_minimum_mismatch'
  | 'wrong_value'
  | 'zero_output'
  | 'minimum_above_output'
  | 'minimum_below_slippage'
  | 'below_oracle_value';

export class UnsafeRouteError extends Error {
  override readonly name = 'UnsafeRouteError';
  constructor(readonly reason: UnsafeRouteReason) {
    super(`unsafe route: ${reason}`);
  }
}

declare const vetted: unique symbol;

/**
 * A provider route that passed every check in `vetRoute`. Only `vetRoute` creates one, and
 * only a vetted route can be signed. `minBuyAmount` is the floor the signed quote enforces.
 */
export type VettedRoute = ProviderQuote & { readonly [vetted]: true };

export interface VetContext {
  /** The request as sent to providers: validated, lowercase EVM addresses, net of the fee. */
  request: QuoteRequest;
  sellPrice: TokenPrice;
  buyPrice: TokenPrice;
  policy: RoutePolicy;
  /** Largest allowed shortfall of the output's oracle value against the input's. */
  maxOracleDeviationBps: number;
}

function evmChainIdOf(chain: string): number | undefined {
  const match = /^evm:(\d+)$/.exec(chain);
  return match ? Number(match[1]) : undefined;
}

/** Lowest acceptable minimum: buyAmount less slippage, rounded down (provider tolerance). */
export function slippageFloor(buyAmount: bigint, slippageBps: number): bigint {
  return (buyAmount * (BPS - BigInt(slippageBps))) / BPS;
}

/** Minimum that gets signed: buyAmount less slippage, rounded up, in the user's favour. */
export function signedMinimum(buyAmount: bigint, slippageBps: number): bigint {
  const scaled = buyAmount * (BPS - BigInt(slippageBps));
  return (scaled + BPS - 1n) / BPS;
}

/** Rejects routes whose output is worth less than the input by more than `maxBps`. */
export function checkOracleValue(
  ctx: Pick<VetContext, 'sellPrice' | 'buyPrice' | 'maxOracleDeviationBps'>,
  sellAmount: bigint,
  buyAmount: bigint,
): void {
  const inUsd = usdE18(ctx.sellPrice, sellAmount);
  const outUsd = usdE18(ctx.buyPrice, buyAmount);
  // outUsd / inUsd >= 1 - maxBps / 10000, cross-multiplied so nothing rounds.
  if (outUsd * BPS < inUsd * (BPS - BigInt(ctx.maxOracleDeviationBps))) {
    throw new UnsafeRouteError('below_oracle_value');
  }
}

function decodeZeroXCalldata(data: string): {
  exec: AllowanceHolderExec;
  settle: SettlerExecute;
} {
  try {
    const exec = decodeAllowanceHolderExec(data as Hex);
    return { exec, settle: decodeSettlerExecute(exec.data) };
  } catch {
    throw new UnsafeRouteError('malformed_calldata');
  }
}

/** Checks 0x AllowanceHolder -> Settler calldata against the request it was quoted for. */
function checkAllowanceHolderCalldata(
  router: TrustedRouter,
  request: QuoteRequest,
  route: ProviderQuote,
): void {
  const { exec, settle } = decodeZeroXCalldata(route.tx.data);
  // The operator gets the transient allowance; it must be the Settler that is called.
  if (exec.operator !== exec.target) throw new UnsafeRouteError('operator_not_target');
  if (!router.targets.includes(exec.target)) throw new UnsafeRouteError('unknown_target');

  const nativeIn = request.sellToken.address === NATIVE;
  const expectedIn = nativeIn ? ZEROX_NATIVE_IN : request.sellToken.address;
  if (exec.token !== expectedIn) throw new UnsafeRouteError('wrong_input_token');
  // The wrapper forwards exactly sellAmount - fee, which is the request providers quoted.
  if (exec.amount !== request.sellAmount) throw new UnsafeRouteError('wrong_input_amount');

  if (settle.recipient !== request.taker.toLowerCase()) {
    throw new UnsafeRouteError('wrong_recipient');
  }
  const expectedOut =
    request.buyToken.address === NATIVE ? ZEROX_NATIVE_OUT : request.buyToken.address;
  if (settle.buyToken !== expectedOut) throw new UnsafeRouteError('wrong_output_token');
  if (settle.minAmountOut !== route.minBuyAmount) {
    throw new UnsafeRouteError('calldata_minimum_mismatch');
  }
}

/**
 * Every check a route must pass before it is offered or signed (ADR 0004). Provider-agnostic
 * bounds apply to all routes; calldata checks depend on the trusted router's kind. Anything
 * unknown is refused (fail closed).
 */
export function vetRoute(ctx: VetContext, route: ProviderQuote): VettedRoute {
  const { request } = ctx;
  const chainId = evmChainIdOf(request.sellToken.chain);
  if (chainId === undefined || request.buyToken.chain !== request.sellToken.chain) {
    throw new UnsafeRouteError('unsupported_chain');
  }
  const router = trustedRouter(ctx.policy, chainId, route.tx.to);
  if (!router) throw new UnsafeRouteError('unknown_router');
  switch (router.kind) {
    case 'zerox-allowance-holder':
      checkAllowanceHolderCalldata(router, request, route);
      break;
  }

  // The wrapper sends its own value; a mismatch means the route was built for something else.
  const expectedValue = request.sellToken.address === NATIVE ? request.sellAmount : 0n;
  if (route.tx.value !== expectedValue) throw new UnsafeRouteError('wrong_value');

  if (route.buyAmount <= 0n) throw new UnsafeRouteError('zero_output');
  if (route.minBuyAmount > route.buyAmount) throw new UnsafeRouteError('minimum_above_output');
  if (route.minBuyAmount < slippageFloor(route.buyAmount, request.slippageBps)) {
    throw new UnsafeRouteError('minimum_below_slippage');
  }
  checkOracleValue(ctx, request.sellAmount, route.buyAmount);

  const floor = signedMinimum(route.buyAmount, request.slippageBps);
  const minBuyAmount = route.minBuyAmount > floor ? route.minBuyAmount : floor;
  return { ...route, minBuyAmount } as VettedRoute;
}

/**
 * Test support only (excluded from the build and coverage): builds 0x AllowanceHolder ->
 * Settler calldata so tests can craft honest and malicious provider responses.
 */
import type { ProviderQuote } from '@ranvier/types';
import { encodeFunctionData, type Hex } from 'viem';
import { ALLOWANCE_HOLDER_ABI, SETTLER_ABI } from '../domain/allowance-holder.js';
import { buildRoutePolicy, type RoutePolicy } from '../domain/route-policy.js';

export const ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';
export const SETTLER = '0x00000000000000000000000000000000005e7713';
export const ATTACKER = '0x000000000000000000000000000000000000bad1';

export const TEST_POLICY: RoutePolicy = buildRoutePolicy({
  1: [{ kind: 'zerox-allowance-holder', address: ALLOWANCE_HOLDER, targets: [SETTLER] }],
  8453: [{ kind: 'zerox-allowance-holder', address: ALLOWANCE_HOLDER, targets: [SETTLER] }],
});

export interface ExecArgs {
  operator: Hex;
  token: Hex;
  amount: bigint;
  target: Hex;
  recipient: Hex;
  buyToken: Hex;
  minAmountOut: bigint;
}

export function settlerCalldata(a: Pick<ExecArgs, 'recipient' | 'buyToken' | 'minAmountOut'>): Hex {
  return encodeFunctionData({
    abi: SETTLER_ABI,
    functionName: 'execute',
    args: [
      { recipient: a.recipient, buyToken: a.buyToken, minAmountOut: a.minAmountOut },
      ['0x1234'],
      `0x${'ab'.repeat(32)}`,
    ],
  });
}

export function execCalldata(a: ExecArgs, inner: Hex = settlerCalldata(a)): Hex {
  return encodeFunctionData({
    abi: ALLOWANCE_HOLDER_ABI,
    functionName: 'exec',
    args: [a.operator, a.token, a.amount, a.target, inner],
  });
}

export interface RouteArgs extends Partial<ExecArgs> {
  buyAmount: bigint;
  minBuyAmount: bigint;
  value?: bigint;
  to?: string;
  data?: Hex;
}

/** A provider quote whose calldata is consistent unless an override says otherwise. */
export function zeroXRoute(defaults: ExecArgs, args: RouteArgs): ProviderQuote {
  const exec: ExecArgs = {
    operator: args.operator ?? defaults.operator,
    token: args.token ?? defaults.token,
    amount: args.amount ?? defaults.amount,
    target: args.target ?? defaults.target,
    recipient: args.recipient ?? defaults.recipient,
    buyToken: args.buyToken ?? defaults.buyToken,
    minAmountOut: args.minAmountOut ?? args.minBuyAmount,
  };
  return {
    provider: '0x',
    buyAmount: args.buyAmount,
    minBuyAmount: args.minBuyAmount,
    buyAmountUsd: 0n,
    gasCostUsd: 0n,
    route: [],
    tx: {
      to: args.to ?? ALLOWANCE_HOLDER,
      data: args.data ?? execCalldata(exec),
      value: args.value ?? 0n,
    },
  };
}

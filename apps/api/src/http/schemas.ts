import { chainFamily, isValidAddress, isValidTokenAddress, NATIVE } from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import { z } from 'zod';
import { HARD_MAX_SLIPPAGE_BPS } from '../config.js';

const MAX_UINT256 = 2n ** 256n - 1n;

const bigintString = z
  .string()
  .regex(/^\d{1,78}$/, 'must be a non-negative integer string')
  .transform((s) => BigInt(s));

const chainKey = z.union([
  z.templateLiteral(['evm:', z.number().int().positive()]),
  z.literal('solana:mainnet'),
]);

/** EVM addresses are case-insensitive, so they are lowercased once, here, for every later use. */
function normalise(chain: ChainKey, address: string): string {
  return chainFamily(chain) === 'evm' && address !== NATIVE ? address.toLowerCase() : address;
}

/**
 * A token is named by chain and address only. Symbol and decimals are not accepted: unknown
 * keys are rejected, so a client cannot believe they are honoured. Decimals come from the
 * price oracle (tokens) or the chain registry (native coin) (ADR 0004).
 */
export const tokenSchema = z
  .strictObject({ chain: chainKey, address: z.string().min(1).max(64) })
  .refine((t) => isValidTokenAddress(chainFamily(t.chain), t.address), {
    message: 'address must be `native` or a valid address for the chain family',
    path: ['address'],
  })
  .transform((t) => ({ chain: t.chain, address: normalise(t.chain, t.address) }));

export const feePreviewSchema = z.strictObject({
  sellToken: tokenSchema,
  buyToken: tokenSchema,
  sellAmount: bigintString,
  usdValueCents: bigintString,
  isFirstSwap: z.boolean().default(false),
});

export interface QuoteSchemaOptions {
  /** Largest accepted `slippageBps`; never above HARD_MAX_SLIPPAGE_BPS. */
  maxSlippageBps: number;
}

export function quoteRequestSchema(opts: QuoteSchemaOptions) {
  const maxSlippage = Math.min(opts.maxSlippageBps, HARD_MAX_SLIPPAGE_BPS);
  return z
    .strictObject({
      sellToken: tokenSchema,
      buyToken: tokenSchema,
      sellAmount: bigintString
        .refine((v) => v > 0n, 'must be greater than zero')
        .refine((v) => v <= MAX_UINT256, 'must fit in uint256'),
      taker: z.string().min(1).max(64),
      slippageBps: z.number().int().min(0).max(maxSlippage),
    })
    .refine((r) => isValidAddress(chainFamily(r.sellToken.chain), r.taker), {
      message: 'taker must be a valid address for the sell chain',
      path: ['taker'],
    })
    .transform((r) => ({ ...r, taker: normalise(r.sellToken.chain, r.taker) }));
}

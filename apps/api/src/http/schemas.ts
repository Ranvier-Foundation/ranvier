import { chainFamily, isValidAddress, isValidTokenAddress, NATIVE } from '@ranvier/chains';
import type { ChainKey } from '@ranvier/types';
import { z, type ZodError } from 'zod';
import { HARD_MAX_SLIPPAGE_BPS } from '../config.js';

const MAX_UINT256 = 2n ** 256n - 1n;

const bigintString = z
  .string()
  .regex(/^\d{1,78}$/, 'must be a non-negative integer string')
  .transform((s) => BigInt(s));

/**
 * `z.templateLiteral` does not enforce `.positive()` on the number part, so EVM keys are also
 * matched against a canonical decimal form: `evm:01`, `evm:0`, `evm:-1` and `evm:1.5` fail.
 */
const chainKey = z.union([
  z
    .templateLiteral(['evm:', z.number().int().positive()])
    .refine((k) => /^evm:[1-9]\d{0,9}$/.test(k), 'must be evm:<chain ID>'),
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

/**
 * A 400 body with a stable code and the offending field paths only (e.g. `sellToken.address`).
 * Validation messages are not returned; paths name the client's own input and leak nothing.
 */
export function invalidRequest(error: ZodError): { error: 'invalid_request'; fields: string[] } {
  const fields = [...new Set(error.issues.map((i) => i.path.map(String).join('.') || '(body)'))];
  return { error: 'invalid_request', fields };
}

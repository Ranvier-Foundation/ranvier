import { z } from 'zod';

const bigintString = z
  .string()
  .regex(/^\d{1,78}$/, 'must be a non-negative integer string')
  .transform((s) => BigInt(s));

export const tokenSchema = z.object({
  chain: z.union([
    z.templateLiteral(['evm:', z.number().int().positive()]),
    z.literal('solana:mainnet'),
  ]),
  address: z.string().min(1).max(64),
  symbol: z.string().min(1).max(32),
  decimals: z.number().int().min(0).max(36),
});

export const feePreviewSchema = z.object({
  sellToken: tokenSchema,
  buyToken: tokenSchema,
  sellAmount: bigintString,
  usdValueCents: bigintString,
  isFirstSwap: z.boolean().default(false),
});

export const quoteRequestSchema = z
  .object({
    sellToken: tokenSchema,
    buyToken: tokenSchema,
    sellAmount: bigintString.refine((v) => v > 0n, 'must be greater than zero'),
    taker: z.string().min(1).max(64),
    slippageBps: z.number().int().min(0).max(5_000),
  })
  .refine((r) => !r.sellToken.chain.startsWith('evm:') || /^0x[0-9a-fA-F]{40}$/.test(r.taker), {
    message: 'taker must be an EVM address',
    path: ['taker'],
  });

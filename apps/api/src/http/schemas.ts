import {
  chainFamily,
  getChain,
  isValidAddress,
  isValidTokenAddress,
  NATIVE,
} from '@ranvier/chains';
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

/** Longest accepted token search text. */
export const MAX_TOKEN_QUERY_LENGTH = 64;
export const DEFAULT_TOKEN_LIMIT = 50;
export const MAX_TOKEN_LIMIT = 100;

/**
 * GET /v1/tokens query (ADR 0006). `chain` must be a registry chain. `q` is optional search text
 * of at most 64 characters: letters, digits, currency signs, spaces, `.`, `_` and `-` (enough for
 * symbols, names and addresses); anything else is malformed. `limit` is a plain decimal integer
 * from 1 to 100, default 50. Unknown parameters and repeated parameters are refused.
 */
export const tokensQuerySchema = z.strictObject({
  chain: chainKey.refine((k) => getChain(k) !== undefined, 'unknown chain'),
  q: z
    .string()
    .max(MAX_TOKEN_QUERY_LENGTH)
    .regex(/^[\p{L}\p{N}\p{Sc} ._-]*$/u, 'unsupported characters')
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, 'must be a positive integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_TOKEN_LIMIT))
    .default(DEFAULT_TOKEN_LIMIT),
});

/** Ethereum-style native placeholders: no wallet can hold their keys. */
const NOT_A_WALLET: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

/**
 * GET /v1/balances query (ADR 0009). `chain` must be a served EVM chain with a curated token
 * list. `address` is a 20-byte hex account in any letter case (no EIP-55 checksum check: the
 * data is public and read-only, and the web app sends the connected wallet's own address); it
 * is lowercased here and never echoed in its raw form. The zero address and `0xeeee...eeee` are
 * refused: they are native-coin placeholders, not wallets. Unknown or repeated parameters are
 * refused.
 */
export function balancesQuerySchema(serves: (chain: ChainKey) => boolean) {
  return z.strictObject({
    chain: chainKey.refine((k) => k.startsWith('evm:') && serves(k), 'not a served EVM chain'),
    address: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
      .transform((a) => a.toLowerCase() as `0x${string}`)
      .refine((a) => !NOT_A_WALLET.has(a), 'not a wallet address'),
  });
}

/**
 * A 400 body with a stable code and the offending field paths only (e.g. `sellToken.address`).
 * Validation messages are not returned; paths name the client's own input and leak nothing.
 */
export function invalidRequest(error: ZodError): { error: 'invalid_request'; fields: string[] } {
  const fields = [...new Set(error.issues.map((i) => i.path.map(String).join('.') || '(body)'))];
  return { error: 'invalid_request', fields };
}

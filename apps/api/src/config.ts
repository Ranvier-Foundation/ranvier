import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const chainIdList = z
  .string()
  .transform((s) => s.split(',').map((id) => Number(id.trim())))
  .pipe(z.array(z.number().int().positive()).min(1));

/** Absolute ceiling for MAX_SLIPPAGE_BPS: no configuration may allow more than 50%. */
export const HARD_MAX_SLIPPAGE_BPS = 5_000;

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(2500),
  /** Fee wrapper address (same on every EVM chain via CREATE2). */
  FEE_WRAPPER_ADDRESS: address.optional(),
  ZEROX_API_KEY: z.string().min(1).optional(),
  /** Development and testnets only; production signs through a KMS. */
  QUOTE_SIGNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  /** How long a signed quote stays valid. */
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
  /** Comma-separated EVM chain IDs where 0x and the fee wrapper are both live. */
  ZEROX_CHAIN_IDS: chainIdList.default([1, 8453, 42161]),
  /**
   * Chains a local QUOTE_SIGNER_PRIVATE_KEY may sign for. Mainnets are always refused,
   * whatever this says. Defaults to Base Sepolia, Sepolia, Arbitrum Sepolia and Anvil.
   */
  LOCAL_SIGNER_CHAIN_IDS: chainIdList.optional(),
  /** Largest slippage a client may request, in bps (default 10%, never above 50%). */
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(HARD_MAX_SLIPPAGE_BPS).default(1_000),
  /**
   * Largest shortfall of a route's output oracle value against its input (net of fee),
   * in bps. Routes beyond it are refused, never signed.
   */
  MAX_ORACLE_DEVIATION_BPS: z.coerce.number().int().min(0).max(5_000).default(500),
});

export type Config = z.infer<typeof envSchema>;

/** An empty value (`KEY=` copied from .env.example) means "not set", not an invalid value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  return envSchema.parse(set);
}

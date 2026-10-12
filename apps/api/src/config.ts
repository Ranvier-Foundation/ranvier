import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(700),
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
  ZEROX_CHAIN_IDS: z
    .string()
    .default('1,8453,42161')
    .transform((s) => s.split(',').map((id) => Number(id.trim())))
    .pipe(z.array(z.number().int().positive())),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}

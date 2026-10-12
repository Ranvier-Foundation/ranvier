import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Key ID, key ARN, alias name or alias ARN, as KMS accepts them in `KeyId`. */
const kmsKeyId = z
  .string()
  .regex(
    /^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key\/[A-Za-z0-9-]+|alias\/[A-Za-z0-9/_-]+)|alias\/[A-Za-z0-9/_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/,
  );

const chainIdList = z
  .string()
  .transform((s) => s.split(',').map((id) => Number(id.trim())))
  .pipe(z.array(z.number().int().positive()).min(1));

/** Absolute ceiling for MAX_SLIPPAGE_BPS: no configuration may allow more than 50%. */
export const HARD_MAX_SLIPPAGE_BPS = 5_000;

const envSchema = z
  .object({
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
    /**
     * AWS KMS fee-signing key (ECC_SECG_P256K1, SIGN_VERIFY): key ARN, alias (`alias/...`) or
     * alias ARN. Credentials come from the default AWS provider chain (instance or task role),
     * never from this config (ADR 0005).
     */
    KMS_KEY_ID: kmsKeyId.optional(),
    /** Region of KMS_KEY_ID. Required when KMS_KEY_ID is set. */
    AWS_REGION: z
      .string()
      .regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/)
      .optional(),
    /** Per KMS Sign call, and the longest wait for a signing slot. */
    KMS_SIGN_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
    /** KMS Sign calls in flight at once; more wait in a bounded queue. */
    KMS_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(256).default(16),
    /** KMS Sign calls waiting for a slot; beyond it quotes fail fast with 503. */
    KMS_MAX_QUEUE: z.coerce.number().int().min(0).max(4_096).default(64),
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
  })
  .superRefine((env, ctx) => {
    // Exactly one signer, and a KMS signer needs its region. These refuse to start rather than
    // pick one silently.
    if (env.KMS_KEY_ID && env.QUOTE_SIGNER_PRIVATE_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['KMS_KEY_ID'],
        message:
          'Set either KMS_KEY_ID (production) or QUOTE_SIGNER_PRIVATE_KEY (development and ' +
          'testnets), not both',
      });
    }
    if (env.KMS_KEY_ID && !env.AWS_REGION) {
      ctx.addIssue({
        code: 'custom',
        path: ['AWS_REGION'],
        message: 'AWS_REGION is required when KMS_KEY_ID is set',
      });
    }
    if (env.KMS_KEY_ID && env.LOCAL_SIGNER_CHAIN_IDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCAL_SIGNER_CHAIN_IDS'],
        message: 'LOCAL_SIGNER_CHAIN_IDS applies to a local key only; unset it with KMS_KEY_ID',
      });
    }
    const arnRegion = env.KMS_KEY_ID?.match(/^arn:aws[a-z-]*:kms:([a-z0-9-]+):/)?.[1];
    if (arnRegion && env.AWS_REGION && arnRegion !== env.AWS_REGION) {
      ctx.addIssue({
        code: 'custom',
        path: ['AWS_REGION'],
        message: `KMS_KEY_ID is in ${arnRegion} but AWS_REGION is ${env.AWS_REGION}`,
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

/** An empty value (`KEY=` copied from .env.example) means "not set", not an invalid value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  return envSchema.parse(set);
}

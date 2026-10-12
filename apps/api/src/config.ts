import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const KEY_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A full KMS key ARN for a single-Region key (multi-Region key IDs start with `mrk-`). */
export const KMS_KEY_ARN = new RegExp(`^arn:aws[a-z-]*:kms:[a-z0-9-]+:\\d{12}:key/${KEY_UUID}$`);

/**
 * Key ARN, alias name, alias ARN or key ID, as KMS accepts them in `KeyId`. Multi-Region key
 * IDs (`mrk-...`) are refused; the signer also refuses any key whose MultiRegion is not false.
 */
const kmsKeyId = z
  .string()
  .refine(
    (v) =>
      KMS_KEY_ARN.test(v) ||
      new RegExp(`^${KEY_UUID}$`).test(v) ||
      /^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:)?alias\/[A-Za-z0-9/_-]+$/.test(v),
    { message: 'expected a key ARN, key ID, alias/... name or alias ARN' },
  );

const chainIdList = z
  .string()
  .transform((s) => s.split(',').map((id) => Number(id.trim())))
  .pipe(z.array(z.number().int().positive()).min(1));

/**
 * Parses WEB_ORIGINS: comma-separated exact browser origins (`scheme://host[:port]`) allowed to
 * call the API cross-origin. Entries are trimmed. Anything a browser would never send as an
 * `Origin` header is refused, so a typo fails startup instead of silently not matching: a path
 * or trailing slash, upper case, a default port, credentials, a wildcard, `null`, a scheme other
 * than http or https, an empty entry, or a duplicate.
 */
export function parseWebOrigins(raw: string): string[] {
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') throw new Error('WEB_ORIGINS has an empty entry');
    // `https://*.example.com` parses as a literal host; wildcards are never supported.
    if (entry.includes('*')) throw new Error(`WEB_ORIGINS entries cannot be wildcards: ${entry}`);
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`WEB_ORIGINS entry is not a URL: ${entry}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`WEB_ORIGINS entry must be http or https: ${entry}`);
    }
    if (url.origin !== entry) {
      throw new Error(
        `WEB_ORIGINS entry must be an exact origin like https://app.example.com ` +
          `(lowercase, no path, no trailing slash, no default port): ${entry}`,
      );
    }
    if (origins.includes(entry)) throw new Error(`WEB_ORIGINS lists ${entry} twice`);
    origins.push(entry);
  }
  return origins;
}

/** Loopback hosts, where plain http is acceptable even in production (local development). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for an https origin, or an http origin on a loopback host. */
export function isSecureOrLoopbackOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === 'https:' || LOOPBACK_HOSTS.has(url.hostname);
}

const webOrigins = z.string().transform((raw, ctx) => {
  try {
    return parseWebOrigins(raw);
  } catch (err: unknown) {
    ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : String(err) });
    return z.NEVER;
  }
});

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
    /**
     * The Ethereum address the KMS key must derive to (the wrapper's `feeSigner`). Required, with
     * a full key ARN in KMS_KEY_ID, under NODE_ENV=production or when any quoted chain is not a
     * known testnet; startup refuses on a mismatch (ADR 0005).
     */
    KMS_EXPECTED_SIGNER_ADDRESS: address.optional(),
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
    /**
     * Browser origins allowed to call the API (CORS), e.g. the web app. Unset: no
     * cross-origin access. Never a wildcard; credentials are never allowed.
     */
    WEB_ORIGINS: webOrigins.default([]),
    /** Only `production` (trimmed, any case) changes behaviour here. */
    NODE_ENV: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // In production a browser origin must be https, unless it is a loopback host.
    if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
      for (const origin of env.WEB_ORIGINS) {
        if (!isSecureOrLoopbackOrigin(origin)) {
          ctx.addIssue({
            code: 'custom',
            path: ['WEB_ORIGINS'],
            message: `WEB_ORIGINS must use https in production (loopback excepted): ${origin}`,
          });
        }
      }
    }
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

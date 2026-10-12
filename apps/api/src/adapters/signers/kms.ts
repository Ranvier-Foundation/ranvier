import {
  DescribeKeyCommand,
  GetPublicKeyCommand,
  SignCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';
import { hashTypedData, hexToBytes, type Hex, type TypedDataDefinition } from 'viem';
import { z } from 'zod';
import { SigningUnavailableError, type QuoteSigner } from '../../ports/quote-signer.js';
import { ConcurrencyLimit, ConcurrencyLimitError } from './concurrency-limit.js';
import {
  addressFromPublicKey,
  parseDerSignature,
  parseSecp256k1Spki,
  toEthereumSignature,
  verifiesAs,
} from './ecdsa.js';

/** The only key configuration this signer accepts (spec section 4, ADR 0005). */
export const KMS_KEY_SPEC = 'ECC_SECG_P256K1';
export const KMS_KEY_USAGE = 'SIGN_VERIFY';
export const KMS_SIGNING_ALGORITHM = 'ECDSA_SHA_256';
/**
 * Key material generated inside AWS KMS or a CloudHSM key store. Imported (`EXTERNAL`) and
 * external key store (`EXTERNAL_KEY_STORE`) keys are refused: their private key exists, or
 * existed, outside an AWS HSM.
 */
export const KMS_ALLOWED_ORIGINS: readonly string[] = ['AWS_KMS', 'AWS_CLOUDHSM'];

export type KmsCommand = DescribeKeyCommand | GetPublicKeyCommand | SignCommand;

/**
 * The slice of the AWS SDK this adapter uses. Outputs are `unknown` on purpose: every
 * response is validated before use, nothing from KMS is trusted blindly.
 */
export interface KmsTransport {
  send(command: KmsCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
}

/**
 * Adapts an AWS SDK `KMSClient` (credentials from the default provider chain; never from our
 * config). Construct the client with `maxAttempts: 1`: this signer does its own bounded retry.
 */
export function awsKmsTransport(client: Pick<KMSClient, 'send'>): KmsTransport {
  return {
    send: (command, options) => {
      if (command instanceof SignCommand) return client.send(command, options);
      if (command instanceof GetPublicKeyCommand) return client.send(command, options);
      return client.send(command, options);
    },
  };
}

/** Our own per-call deadline fired before KMS answered. */
export class KmsTimeoutError extends Error {
  override readonly name = 'KmsTimeoutError';
}

/** AWS errors worth one more attempt: throttling and transient service-side failures. */
const RETRYABLE = new Set([
  'ThrottlingException',
  'DependencyTimeoutException',
  'KMSInternalException',
  'KeyUnavailableException',
  'KmsTimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

/** Never retried: retrying cannot help, and it would hide a revoked role or a bad key. */
const NEVER_RETRY = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'ExpiredTokenException',
  'IncompleteSignature',
  'NotFoundException',
  'DisabledException',
  'InvalidKeyUsageException',
  'KMSInvalidStateException',
  'InvalidArnException',
  'InvalidGrantTokenException',
  'UnsupportedOperationException',
  'ValidationException',
  'CredentialsProviderError',
]);

function errorName(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err;
  const name = 'name' in err && typeof err.name === 'string' ? err.name : 'Error';
  const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined;
  return name === 'Error' && code ? code : name;
}

export function isRetryable(err: unknown): boolean {
  const name = errorName(err);
  if (NEVER_RETRY.has(name)) return false;
  if (RETRYABLE.has(name)) return true;
  return typeof err === 'object' && err !== null && '$fault' in err && err.$fault === 'server';
}

/** The message of anything thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Error name and a bounded message: enough for the server log, never credentials. */
function describeError(err: unknown): string {
  return `${errorName(err)}: ${errorMessage(err).slice(0, 200)}`;
}

const bytes = z.instanceof(Uint8Array);

const describeKeyOutput = z.object({
  KeyMetadata: z.object({
    Arn: z.string().regex(/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/),
    KeyState: z.string().optional(),
    KeySpec: z.string().optional(),
    KeyUsage: z.string().optional(),
    KeyManager: z.string().optional(),
    Origin: z.string().optional(),
    SigningAlgorithms: z.array(z.string()).optional(),
    MultiRegion: z.boolean().optional(),
  }),
});

const getPublicKeyOutput = z.object({
  KeyId: z.string(),
  PublicKey: bytes,
  KeySpec: z.string().optional(),
  KeyUsage: z.string().optional(),
});

const signOutput = z.object({
  KeyId: z.string(),
  Signature: bytes,
  SigningAlgorithm: z.string(),
});

export interface KmsSignerOptions {
  /** Key ARN, alias name (`alias/...`), alias ARN or key ID. Resolved to the key ARN once. */
  keyId: string;
  transport: KmsTransport;
  /**
   * Chains this signer may sign for. Startup checks that each has a trusted router policy
   * (`assertKmsSigningChains`); `canSignChain` checks it again per request.
   */
  chainIds: readonly number[];
  /** Per KMS call (default 2000 ms). Also the longest wait for a concurrency slot. */
  timeoutMs?: number;
  /** Per KMS call during `create` (default 10000 ms: the first call also fetches credentials). */
  startupTimeoutMs?: number;
  /** Pause before the single retry (default 100 ms). */
  retryDelayMs?: number;
  /** Sign calls in flight at once (default 16). */
  maxInFlight?: number;
  /** Sign calls waiting for a slot (default 64); beyond it signing fails fast. */
  maxQueue?: number;
}

export interface KmsKeyInfo {
  keyArn: string;
  address: Hex;
  keySpec: string;
  keyUsage: string;
  keyState: string;
  origin: string;
}

type Defaults = Required<Omit<KmsSignerOptions, 'keyId' | 'transport' | 'chainIds'>>;

const DEFAULTS: Defaults = {
  timeoutMs: 2_000,
  startupTimeoutMs: 10_000,
  retryDelayMs: 100,
  maxInFlight: 16,
  maxQueue: 64,
};

/** At most one retry, and only for throttling and transient errors. */
const MAX_ATTEMPTS = 2;

async function sendOnce(
  transport: KmsTransport,
  command: KmsCommand,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new KmsTimeoutError(`KMS did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    // The race returns on time even if the SDK ignored the abort signal.
    return await Promise.race([
      transport.send(command, { abortSignal: controller.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendWithRetry(
  transport: KmsTransport,
  makeCommand: () => KmsCommand,
  timeoutMs: number,
  retryDelayMs: number,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendOnce(transport, makeCommand(), timeoutMs);
    } catch (err: unknown) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Signs fee-wrapper quotes with an asymmetric AWS KMS key (ECC_SECG_P256K1, SIGN_VERIFY).
 * The private key never leaves KMS (spec section 4, ADR 0005).
 *
 * - `create` checks the key (spec, usage, state, origin) and derives the Ethereum address
 *   from its public key; construction fails on any KMS error.
 * - Each signature is KMS `Sign` over the 32-byte EIP-712 digest (`MessageType: DIGEST`,
 *   `ECDSA_SHA_256`), converted from DER to a low-s `r || s || v`, and verified by recovery
 *   against `address` before it is returned. Anything else fails closed.
 * - Calls are bounded: a per-call timeout, one retry on throttling or transient errors only,
 *   and an in-memory limit on concurrent and queued Sign calls.
 */
export class KmsSigner implements QuoteSigner {
  readonly kind = 'kms' as const;
  private readonly chains: ReadonlySet<number>;
  private readonly limit: ConcurrencyLimit;

  private constructor(
    readonly info: KmsKeyInfo,
    private readonly transport: KmsTransport,
    chainIds: readonly number[],
    private readonly opts: Defaults,
  ) {
    this.chains = new Set(chainIds);
    this.limit = new ConcurrencyLimit({
      maxInFlight: opts.maxInFlight,
      maxQueue: opts.maxQueue,
      maxWaitMs: opts.timeoutMs,
    });
  }

  get address(): Hex {
    return this.info.address;
  }

  get keyArn(): string {
    return this.info.keyArn;
  }

  /** Resolves and checks the key, then derives its address. Throws with a clear message. */
  static async create(options: KmsSignerOptions): Promise<KmsSigner> {
    const { keyId, transport, chainIds } = options;
    const opts: Defaults = {
      timeoutMs: positiveInt('timeoutMs', options.timeoutMs ?? DEFAULTS.timeoutMs),
      startupTimeoutMs: positiveInt(
        'startupTimeoutMs',
        options.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs,
      ),
      retryDelayMs: options.retryDelayMs ?? DEFAULTS.retryDelayMs,
      maxInFlight: positiveInt('maxInFlight', options.maxInFlight ?? DEFAULTS.maxInFlight),
      maxQueue: options.maxQueue ?? DEFAULTS.maxQueue,
    };
    if (keyId.trim() === '') throw new Error('KMS key ID is empty');
    if (chainIds.length === 0 || !chainIds.every((id) => Number.isInteger(id) && id > 0)) {
      throw new Error('KmsSigner needs at least one valid chain ID to sign for');
    }
    const call = async (makeCommand: () => KmsCommand, what: string): Promise<unknown> => {
      try {
        return await sendWithRetry(
          transport,
          makeCommand,
          opts.startupTimeoutMs,
          opts.retryDelayMs,
        );
      } catch (err: unknown) {
        throw new Error(`KMS ${what} failed for ${keyId}: ${describeError(err)}`, { cause: err });
      }
    };

    const described = describeKeyOutput.safeParse(
      await call(() => new DescribeKeyCommand({ KeyId: keyId }), 'DescribeKey'),
    );
    if (!described.success) throw new Error(`KMS DescribeKey returned an unexpected response`);
    const meta = described.data.KeyMetadata;
    const keyArn = meta.Arn;
    const refused = (what: string): Error => new Error(`KMS key ${keyArn} refused: ${what}`);
    if (meta.KeyState !== 'Enabled')
      throw refused(`KeyState is ${String(meta.KeyState)}, not Enabled`);
    if (meta.KeySpec !== KMS_KEY_SPEC) throw refused(`KeySpec is ${String(meta.KeySpec)}`);
    if (meta.KeyUsage !== KMS_KEY_USAGE) throw refused(`KeyUsage is ${String(meta.KeyUsage)}`);
    if (meta.KeyManager !== 'CUSTOMER') throw refused(`KeyManager is ${String(meta.KeyManager)}`);
    // A multi-Region key shares its key material with replicas in other Regions, each with its
    // own key policy. Only single-Region keys are accepted; a missing field is refused too.
    if (meta.MultiRegion !== false) {
      throw refused(`MultiRegion is ${String(meta.MultiRegion)}; use a single-Region key`);
    }
    const origin = meta.Origin;
    if (origin === undefined || !KMS_ALLOWED_ORIGINS.includes(origin)) {
      throw refused(`Origin is ${String(origin)}; key material must be generated in AWS`);
    }
    if (!meta.SigningAlgorithms?.includes(KMS_SIGNING_ALGORITHM)) {
      throw refused(`${KMS_SIGNING_ALGORITHM} is not supported`);
    }

    // From here on the key is addressed by its ARN, so a later alias change cannot swap the
    // key under a running process.
    const pub = getPublicKeyOutput.safeParse(
      await call(() => new GetPublicKeyCommand({ KeyId: keyArn }), 'GetPublicKey'),
    );
    if (!pub.success) throw new Error('KMS GetPublicKey returned an unexpected response');
    if (pub.data.KeyId !== keyArn) throw refused('GetPublicKey answered for a different key');
    if (pub.data.KeySpec !== KMS_KEY_SPEC || pub.data.KeyUsage !== KMS_KEY_USAGE) {
      throw refused('GetPublicKey reports a different KeySpec or KeyUsage');
    }
    let address: Hex;
    try {
      address = addressFromPublicKey(parseSecp256k1Spki(pub.data.PublicKey));
    } catch (err: unknown) {
      throw refused(describeError(err));
    }

    const info: KmsKeyInfo = {
      keyArn,
      address,
      keySpec: KMS_KEY_SPEC,
      keyUsage: KMS_KEY_USAGE,
      keyState: 'Enabled',
      origin,
    };
    return new KmsSigner(info, transport, chainIds, opts);
  }

  canSign(chainId: number): boolean {
    return this.chains.has(chainId);
  }

  async signTypedData(typedData: TypedDataDefinition): Promise<Hex> {
    const chainId = typedData.domain?.chainId;
    if (chainId === undefined || !this.canSign(Number(chainId))) {
      throw new Error(`KmsSigner refuses chain ${String(chainId)}`);
    }
    return this.signDigest(hashTypedData(typedData));
  }

  /** Signs a 32-byte digest; returns only a signature that verifies as `address`. */
  private async signDigest(digest: Hex): Promise<Hex> {
    let der: Uint8Array;
    try {
      der = await this.limit.run(() => this.kmsSign(digest));
    } catch (err: unknown) {
      if (err instanceof SigningUnavailableError) throw err;
      if (err instanceof ConcurrencyLimitError) {
        throw new SigningUnavailableError('busy', `KMS signing ${err.message}`);
      }
      if (err instanceof KmsTimeoutError) {
        throw new SigningUnavailableError('timeout', describeError(err));
      }
      throw new SigningUnavailableError('upstream', `KMS Sign failed: ${describeError(err)}`);
    }

    let signature: Hex;
    try {
      signature = await toEthereumSignature(digest, parseDerSignature(der), this.address);
    } catch (err: unknown) {
      throw new SigningUnavailableError(
        'integrity',
        `KMS signature rejected: ${describeError(err)}`,
      );
    }
    // Final check, independent of the conversion: never return a signature the fee wrapper
    // would reject or that recovers to anyone but this signer.
    if (!(await verifiesAs(digest, signature, this.address))) {
      throw new SigningUnavailableError('integrity', 'KMS signature failed self-verification');
    }
    return signature;
  }

  private async kmsSign(digest: Hex): Promise<Uint8Array> {
    const out = await sendWithRetry(
      this.transport,
      () =>
        new SignCommand({
          KeyId: this.keyArn,
          Message: hexToBytes(digest),
          MessageType: 'DIGEST',
          SigningAlgorithm: KMS_SIGNING_ALGORITHM,
        }),
      this.opts.timeoutMs,
      this.opts.retryDelayMs,
    );
    const parsed = signOutput.safeParse(out);
    if (!parsed.success) {
      throw new SigningUnavailableError('integrity', 'KMS Sign returned an unexpected response');
    }
    if (parsed.data.KeyId !== this.keyArn) {
      throw new SigningUnavailableError('integrity', 'KMS Sign answered for a different key');
    }
    if (parsed.data.SigningAlgorithm !== KMS_SIGNING_ALGORITHM) {
      throw new SigningUnavailableError('integrity', 'KMS Sign used a different algorithm');
    }
    return parsed.data.Signature;
  }
}

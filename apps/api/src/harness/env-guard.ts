/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, section 4).
 * Lives in `src/harness/`: excluded from the build (`dist/`), never imported by production code.
 *
 * The harness API's environment checks. Pure: no network, no file, no listen. Every refusal
 * happens here, before the harness entry sends any RPC request or opens a port:
 *
 * 1. `RANVIER_ENV` is exactly `harness`, and `NODE_ENV` is not `production` (any case);
 * 2. `ZEROX_CHAIN_IDS` is exactly `31337`;
 * 3. none of `KMS_KEY_ID`, `KMS_EXPECTED_SIGNER_ADDRESS`, `ZEROX_API_KEY`,
 *    `QUOTE_SIGNER_PRIVATE_KEY`, `LOCAL_SIGNER_CHAIN_IDS` is present (even empty): the harness
 *    signs only with the published key it derives itself, and quotes only its own mock pairs;
 * 4. no `RPC_URLS_EVM_<id>` for any chain but 31337 (a shell can leak one in); `RPC_URLS_EVM_31337`
 *    is exactly one `http://127.0.0.1:<port>` or `http://[::1]:<port>` URL (refused even if it
 *    would answer 31337: the chain ID is not reserved); `RANVIER_HARNESS_RPC_URL`, if set, is the
 *    same URL;
 * 5. `HOST` is `127.0.0.1` or `::1` (default `127.0.0.1`), `PORT` is not 3000 (default 4310);
 * 6. every `WEB_ORIGINS` entry is a loopback origin;
 * 7. `FEE_WRAPPER_ADDRESS`, if set, is the pinned local wrapper.
 *
 * The 31337 values are literals, never derived from data (PR 3 review, M1).
 */
import { LOCAL_DEV_CONTRACTS } from '@ranvier/chains/local-dev';
import { getAddress, type Hex } from 'viem';
import { ZodError } from 'zod';
import { loadConfig, parseWebOrigins, type Config } from '../config.js';
import { RPC_ENV_PREFIX } from '../rpc-config.js';
import { assertLoopbackRpcUrl, HarnessRpcRefusedError, RPC_URL_ENV } from './rpc-guard.js';

/** The harness refuses to start. Nothing has been sent or opened. */
export class HarnessRefusedError extends Error {
  override readonly name = 'HarnessRefusedError';
}

/** The harness API's port in the runbook (anvil 8645, API 4310, web 3310). */
export const HARNESS_API_PORT = 4310;
/** The owner's development web server: never used by the harness. */
const OWNER_DEV_PORT = 3000;

/** Variables that would put another key, a KMS key or a real provider into the harness. */
export const FORBIDDEN_VARIABLES: readonly string[] = [
  'KMS_KEY_ID',
  'KMS_EXPECTED_SIGNER_ADDRESS',
  'ZEROX_API_KEY',
  'QUOTE_SIGNER_PRIVATE_KEY',
  'LOCAL_SIGNER_CHAIN_IDS',
];

const BIND_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1']);
const ORIGIN_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

export interface HarnessEnv {
  /** The one RPC endpoint, loopback, without a trailing slash. */
  rpcUrl: string;
  host: string;
  port: number;
  /** The pinned local FeeWrapper, checksummed. */
  feeWrapper: Hex;
  /** The rest of the API configuration, parsed by the production `loadConfig`. */
  config: Config;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Returns the harness configuration, or throws `HarnessRefusedError` naming the first problem. */
export function assertHarnessEnv(env: Env): HarnessEnv {
  const refuse = (why: string): never => {
    throw new HarnessRefusedError(`harness API refused: ${why}`);
  };
  if (env.RANVIER_ENV !== 'harness') refuse('RANVIER_ENV must be exactly "harness"');
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
    refuse('NODE_ENV is production; the harness never runs in production');
  }
  if (env.ZEROX_CHAIN_IDS !== '31337') refuse('ZEROX_CHAIN_IDS must be exactly "31337"');
  for (const name of FORBIDDEN_VARIABLES) {
    if (env[name] !== undefined) refuse(`${name} is set; unset it (the harness uses no real key)`);
  }

  const rpcName = `${RPC_ENV_PREFIX}31337`;
  for (const name of Object.keys(env)) {
    if (name.startsWith(RPC_ENV_PREFIX) && name !== rpcName && env[name] !== undefined) {
      refuse(`${name} is set; only ${rpcName} may be (it may have leaked in from your shell)`);
    }
  }
  const raw = env[rpcName];
  if (raw === undefined || raw.includes(',')) {
    refuse(`${rpcName} must be exactly one URL: http://127.0.0.1:<port> of a local anvil`);
  }
  let rpcUrl = '';
  try {
    rpcUrl = assertLoopbackRpcUrl(raw?.trim());
  } catch (err: unknown) {
    if (!(err instanceof HarnessRpcRefusedError)) throw err;
    refuse(`${rpcName}: ${err.message}`);
  }
  const alias = env[RPC_URL_ENV];
  if (alias !== undefined && alias.replace(/\/$/, '') !== rpcUrl) {
    refuse(`${RPC_URL_ENV} is set to another URL than ${rpcName}`);
  }

  const host = env.HOST ?? '127.0.0.1';
  if (!BIND_HOSTS.has(host)) refuse('HOST must be 127.0.0.1 or ::1');
  const port = env.PORT === undefined ? HARNESS_API_PORT : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) refuse('PORT must be 1..65535');
  if (port === OWNER_DEV_PORT) refuse('PORT 3000 is the owner dev server, never the harness');

  if (env.WEB_ORIGINS !== undefined && env.WEB_ORIGINS.trim() !== '') {
    let origins: string[] = [];
    try {
      origins = parseWebOrigins(env.WEB_ORIGINS);
    } catch (err: unknown) {
      refuse(`WEB_ORIGINS: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const origin of origins) {
      if (!ORIGIN_HOSTS.has(new URL(origin).hostname)) {
        refuse(`WEB_ORIGINS must be loopback origins only: ${origin}`);
      }
    }
  }

  const feeWrapper = getAddress(LOCAL_DEV_CONTRACTS.feeWrapper);
  const configured = env.FEE_WRAPPER_ADDRESS;
  if (configured !== undefined && configured.toLowerCase() !== feeWrapper.toLowerCase()) {
    refuse('FEE_WRAPPER_ADDRESS is not the pinned local FeeWrapper');
  }

  let config: Config | undefined;
  try {
    config = loadConfig({ ...env, HOST: host, PORT: String(port) });
  } catch (err: unknown) {
    // Paths only: a value could be a key someone pasted in the wrong variable.
    const fields = err instanceof ZodError ? err.issues.map((i) => i.path.join('.')) : [];
    refuse(`the API configuration is invalid: ${fields.join(', ') || 'unknown field'}`);
  }
  return { rpcUrl, host, port, feeWrapper, config: config as Config };
}

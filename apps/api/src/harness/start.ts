/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, sections 2 to 4).
 * Lives in `src/harness/`: excluded from the build (`dist/`), never imported by production code.
 *
 * Starts the real API server on the local test chain: `buildServerWithCatalog` with the registry
 * plus `LOCAL_DEV_CHAIN`, the harness 0x-shaped provider and fixed-price oracle, the 31337 route
 * policy (the mock AllowanceHolder and Settler), and a `LocalKeySigner` for `[31337]` only with a
 * PUBLIC anvil key derived in memory. Everything else is production code, unchanged.
 *
 * Order, so every refusal comes before any RPC request or open port:
 * 1. `assertHarnessEnv` (pure);
 * 2. the signer, derived in memory (no network);
 * 3. `verifyLocalChain`: one `eth_chainId`, which must be 31337;
 * 4. the production `FeeSignerMonitor`: code, `feeSigner()` and the EIP-712 domain of the pinned
 *    wrapper must match the signer, through the production reader;
 * 5. only then the server is built and listens, on loopback.
 */
import type { FastifyInstance } from 'fastify';
import type { Hex } from 'viem';
import { AssumeReturningWallets } from '../adapters/history/assume-returning.js';
import { ViemChainReader, type ReaderLog } from '../adapters/rpc/viem-chain-reader.js';
import { LocalKeySigner } from '../adapters/signers/local-key.js';
import { BalanceService } from '../domain/balances.js';
import { buildRoutePolicy, type RoutePolicy } from '../domain/route-policy.js';
import { FeeSignerMonitor } from '../fee-signer-check.js';
import { buildServerWithCatalog, type ServerDeps } from '../http/server.js';
import { assertNotPublishedSigner, isPublishedDevAddress } from '../published-addresses.js';
import { harnessCatalog } from './catalog.js';
import { anvilAccount, publicAnvilKey } from './dev-accounts.js';
import { assertHarnessEnv, HarnessRefusedError } from './env-guard.js';
import { FixedPriceOracle, HarnessQuoteProvider } from './fixtures.js';
import { ACCOUNT_INDEX, PINNED } from './pinned.js';
import { verifyLocalChain } from './rpc-guard.js';

/** Chains a harness signer must refuse (every mainnet in the registry and the three testnets). */
const NEVER_HARNESS_CHAINS: readonly number[] = [
  1, 10, 56, 137, 8453, 42161, 43114, 84532, 11155111, 421614,
];

/**
 * The harness fee signer: anvil account 1 (the `FEE_SIGNER` the runbook deploy sets), a PUBLIC
 * anvil key, chain 31337 only, derived in memory from the published mnemonic and never printed.
 * Allowed for `[31337]` LITERALLY: not the default list (which includes three testnets), not
 * derived from data. Refuses to return a signer that is not a published key or that accepts any
 * other chain.
 */
export function harnessSigner(): LocalKeySigner {
  const signer = new LocalKeySigner(publicAnvilKey(anvilAccount(ACCOUNT_INDEX.feeSigner)), {
    allowedChainIds: [31337],
  });
  if (!isPublishedDevAddress(signer.address)) {
    throw new HarnessRefusedError(
      'harness API refused: the harness signer must be a published key',
    );
  }
  // The production guard, applied to the harness's own chain list: passes for 31337 only.
  assertNotPublishedSigner(signer.address, [31337], 'The harness signer');
  if (!signer.canSign(31337) || NEVER_HARNESS_CHAINS.some((id) => signer.canSign(id))) {
    throw new HarnessRefusedError('harness API refused: the harness signer must sign 31337 only');
  }
  return signer;
}

/** The trusted router policy for 31337 only: the mock AllowanceHolder, the MockSettler as target. */
export function harnessRoutePolicy(): RoutePolicy {
  return buildRoutePolicy({
    31337: [
      {
        kind: 'zerox-allowance-holder',
        address: PINNED.allowanceHolder,
        targets: [PINNED.settler],
      },
    ],
  });
}

export interface HarnessStartOptions {
  /** Every outbound request (the RPC); tests pass a fake. */
  fetch?: typeof fetch;
  /** Structured, non-secret log lines (default: JSON on stderr). */
  log?: ReaderLog;
  /** Fastify's own request log (default off). */
  logger?: ServerDeps['logger'];
}

export interface HarnessApi {
  /** `http://127.0.0.1:<port>` or `http://[::1]:<port>`. */
  url: string;
  app: FastifyInstance;
  /** The signer address (public). */
  signer: Hex;
  /** Runs the runtime `feeSigner()` re-check now (otherwise every 10 minutes). */
  refreshSignerCheck(): Promise<void>;
  close(): Promise<void>;
}

const stderrLog: ReaderLog = {
  info: (obj, msg) => process.stderr.write(`${JSON.stringify({ level: 'info', msg, ...obj })}\n`),
  warn: (obj, msg) => process.stderr.write(`${JSON.stringify({ level: 'warn', msg, ...obj })}\n`),
  error: (obj, msg) => process.stderr.write(`${JSON.stringify({ level: 'error', msg, ...obj })}\n`),
};

/** Starts the harness API, or throws (`HarnessRefusedError` and friends) before any listen. */
export async function startHarnessApi(
  env: Readonly<Record<string, string | undefined>>,
  opts: HarnessStartOptions = {},
): Promise<HarnessApi> {
  const harness = assertHarnessEnv(env);
  const { config } = harness;
  const signer = harnessSigner();
  const log = opts.log ?? stderrLog;

  // The first request: eth_chainId to the loopback endpoint only, which must answer 31337.
  await verifyLocalChain(harness.rpcUrl, opts.fetch ? { fetch: opts.fetch } : {});

  // The production reader and signer check. Plain anvil has no Multicall3, and 31337 is not in
  // MULTICALL3_CHAINS, so balances use the reader's individual-call path (ADR 0009). Anvil mines
  // only on demand, so its newest block can be old (and evm_increaseTime moves it ahead): the
  // block-age bounds are a day here (display data only).
  const reader = new ViemChainReader({
    endpoints: new Map([[31337, [{ url: harness.rpcUrl, label: 'RPC_URLS_EVM_31337[0]' }]]]),
    requestTimeoutMs: config.RPC_REQUEST_TIMEOUT_MS,
    rank: false,
    maxBlockAgeSeconds: 86_400,
    maxClockSkewSeconds: 86_400,
    log,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const monitor = new FeeSignerMonitor({
    reader,
    chainIds: [31337],
    feeWrapper: harness.feeWrapper,
    signer: signer.address,
    log,
  });
  await reader.verifyEndpoints();
  await monitor.verifyAtStartup();

  const catalog = harnessCatalog();
  const balanceService = new BalanceService({
    reader,
    servedChainIds: [31337],
    catalog,
    deadlineMs: config.BALANCES_DEADLINE_MS,
    cacheTtlMs: config.BALANCES_CACHE_TTL_MS,
  });
  const app = buildServerWithCatalog(
    {
      providers: [new HarnessQuoteProvider()],
      prices: new FixedPriceOracle(),
      history: new AssumeReturningWallets(),
      routePolicy: harnessRoutePolicy(),
      providerTimeoutMs: config.PROVIDER_TIMEOUT_MS,
      maxSlippageBps: config.MAX_SLIPPAGE_BPS,
      maxOracleDeviationBps: config.MAX_ORACLE_DEVIATION_BPS,
      logger: opts.logger ?? false,
      webOrigins: config.WEB_ORIGINS,
      servedChainIds: [31337],
      balances: { service: balanceService, deadlineMs: config.BALANCES_DEADLINE_MS },
      signing: {
        feeWrapper: harness.feeWrapper,
        signer: monitor.gate(signer),
        ttlSeconds: config.QUOTE_TTL_SECONDS,
      },
    },
    catalog,
  );
  try {
    await app.listen({ host: harness.host, port: harness.port });
  } catch (err: unknown) {
    await app.close();
    throw err;
  }
  monitor.start();
  const hostPart = harness.host === '::1' ? '[::1]' : '127.0.0.1';
  return {
    url: `http://${hostPart}:${harness.port}`,
    app,
    signer: signer.address,
    refreshSignerCheck: () => monitor.refresh(),
    close: async () => {
      monitor.stop();
      await app.close();
    },
  };
}

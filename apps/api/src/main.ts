import { KMSClient } from '@aws-sdk/client-kms';
import { AssumeReturningWallets } from './adapters/history/assume-returning.js';
import { DefiLlamaPriceOracle } from './adapters/prices/defillama.js';
import { ViemChainReader, type ReaderLog } from './adapters/rpc/viem-chain-reader.js';
import { awsKmsTransport, KmsSigner } from './adapters/signers/kms.js';
import { ZeroXProvider } from './adapters/providers/zero-x.js';
import { loadConfig } from './config.js';
import { balanceChainIds, BalanceService } from './domain/balances.js';
import { FeeSignerMonitor, signingChainIds } from './fee-signer-check.js';
import { buildServer } from './http/server.js';
import type { QuoteProvider } from './ports/quote-provider.js';
import { loadRpcConfig } from './rpc-config.js';
import { setUpSigning } from './signer-setup.js';
import { TRUSTED_ROUTERS } from './trusted-routers.js';

const config = loadConfig();
const prices = new DefiLlamaPriceOracle();
const providers: QuoteProvider[] = [];

if (config.ZEROX_API_KEY && config.FEE_WRAPPER_ADDRESS) {
  providers.push(
    new ZeroXProvider({
      apiKey: config.ZEROX_API_KEY,
      feeWrapper: config.FEE_WRAPPER_ADDRESS,
      chainIds: config.ZEROX_CHAIN_IDS,
      prices,
    }),
  );
}

// Fails startup (rejects) on a bad signer configuration, a published development signer off
// chain 31337, or any KMS error. Credentials come from the default AWS provider chain; the SDK's
// own retries are off (KmsSigner retries once).
const signing = await setUpSigning(config, {
  policy: TRUSTED_ROUTERS,
  kmsTransport: (region) => awsKmsTransport(new KMSClient({ region, maxAttempts: 1 })),
});
// The chains quotes are really signed for; FeeWrapper.feeSigner() is checked on each below.
const signChains = signing
  ? signingChainIds(config.ZEROX_CHAIN_IDS, signing.signer, TRUSTED_ROUTERS)
  : [];

// Balance reads (ADR 0009): our own RPC endpoints, never the browser's. Fails startup on an
// invalid RPC_URLS_EVM_* variable (the error names the variable, never its value). The signing
// chains need an endpoint too, for the feeSigner check; today every one is a balance chain.
const balanceChains = balanceChainIds(config.ZEROX_CHAIN_IDS);
const rpc = loadRpcConfig(process.env, [...new Set([...balanceChains, ...signChains])]);
// Reader log lines carry chain IDs, endpoint labels and error classes: never URLs or addresses.
// `app` is assigned below, before anything can log.
const readerLog: ReaderLog = {
  info: (obj, msg) => app.log.info({ component: 'chain-reader', ...obj }, msg),
  warn: (obj, msg) => app.log.warn({ component: 'chain-reader', ...obj }, msg),
  error: (obj, msg) => app.log.error({ component: 'chain-reader', ...obj }, msg),
};
const reader = new ViemChainReader({
  endpoints: rpc.endpoints,
  requestTimeoutMs: config.RPC_REQUEST_TIMEOUT_MS,
  rank: config.RPC_RANK_INTERVAL_MS > 0 ? { intervalMs: config.RPC_RANK_INTERVAL_MS } : false,
  log: readerLog,
});
// FeeWrapper.feeSigner(), its code and EIP-712 domain on every signing chain (ADR 0005): checked
// before the server listens (fail closed), then every 10 minutes; a chain that stops matching is
// not signed for until it matches again.
const feeSigners = signing
  ? new FeeSignerMonitor({
      reader,
      chainIds: signChains,
      feeWrapper: signing.feeWrapper,
      signer: signing.signer.address,
      log: {
        info: (obj, msg) => app.log.info({ component: 'fee-signer-check', ...obj }, msg),
        warn: (obj, msg) => app.log.warn({ component: 'fee-signer-check', ...obj }, msg),
        error: (obj, msg) => app.log.error({ component: 'fee-signer-check', ...obj }, msg),
      },
    })
  : undefined;
const balanceService = new BalanceService({
  reader,
  servedChainIds: config.ZEROX_CHAIN_IDS,
  deadlineMs: config.BALANCES_DEADLINE_MS,
  cacheTtlMs: config.BALANCES_CACHE_TTL_MS,
});

const app = buildServer({
  providers,
  prices,
  history: new AssumeReturningWallets(),
  routePolicy: TRUSTED_ROUTERS,
  providerTimeoutMs: config.PROVIDER_TIMEOUT_MS,
  maxSlippageBps: config.MAX_SLIPPAGE_BPS,
  maxOracleDeviationBps: config.MAX_ORACLE_DEVIATION_BPS,
  logger: true,
  webOrigins: config.WEB_ORIGINS,
  servedChainIds: config.ZEROX_CHAIN_IDS,
  balances: { service: balanceService, deadlineMs: config.BALANCES_DEADLINE_MS },
  ...(signing && feeSigners
    ? { signing: { ...signing, signer: feeSigners.gate(signing.signer) } }
    : {}),
});

if (rpc.publicDefaultChains.length > 0) {
  app.log.warn(
    { chains: rpc.publicDefaultChains },
    'balance reads use PUBLIC development RPC endpoints for these chains: never in production; ' +
      'set RPC_URLS_EVM_<chainId> (docs/runbooks/rpc-providers.md)',
  );
}
if (rpc.ignored.length > 0) {
  app.log.warn({ variables: rpc.ignored }, 'RPC variables for chains without balances ignored');
}
// Every endpoint must prove its chain (eth_chainId) before it serves a balance; one pointed at
// another chain is dropped. Unreachable ones are asked again every 30 s.
await reader.verifyEndpoints();
setInterval(() => void reader.verifyEndpoints(), 30_000).unref();

if (feeSigners) {
  try {
    await feeSigners.verifyAtStartup();
  } catch (err: unknown) {
    // Addresses and chain IDs only (all public); never a URL.
    app.log.error({ err: err instanceof Error ? err.message : String(err) }, 'startup refused');
    process.exit(1);
  }
  feeSigners.start();
}

// The signer address and key ARN only: never credentials.
app.log.info(
  {
    providers: providers.map((p) => p.name),
    webOrigins: config.WEB_ORIGINS,
    signer: signing?.signer.address ?? null,
    signerKind: signing?.signer.kind ?? null,
    kmsKeyArn: signing?.signer instanceof KmsSigner ? signing.signer.keyArn : null,
    signingChains: signChains,
    balanceChains: balanceChains.filter((id) => reader.canRead(id)),
  },
  'quote service configured',
);

app.listen({ port: config.PORT, host: config.HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

import { KMSClient } from '@aws-sdk/client-kms';
import { AssumeReturningWallets } from './adapters/history/assume-returning.js';
import { DefiLlamaPriceOracle } from './adapters/prices/defillama.js';
import { ViemChainReader, type ReaderLog } from './adapters/rpc/viem-chain-reader.js';
import { awsKmsTransport, KmsSigner } from './adapters/signers/kms.js';
import { ZeroXProvider } from './adapters/providers/zero-x.js';
import { loadConfig } from './config.js';
import { balanceChainIds, BalanceService } from './domain/balances.js';
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

// Fails startup (rejects) on a bad signer configuration or any KMS error. Credentials come
// from the default AWS provider chain; the SDK's own retries are off (KmsSigner retries once).
// Once RPC access exists, compare FeeWrapper.feeSigner() with the signer address here
// (ADR 0005).
const signing = await setUpSigning(config, {
  policy: TRUSTED_ROUTERS,
  kmsTransport: (region) => awsKmsTransport(new KMSClient({ region, maxAttempts: 1 })),
});

// Balance reads (ADR 0009): our own RPC endpoints, never the browser's. Fails startup on an
// invalid RPC_URLS_EVM_* variable (the error names the variable, never its value).
const rpc = loadRpcConfig(process.env, balanceChainIds(config.ZEROX_CHAIN_IDS));
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
  ...(signing ? { signing } : {}),
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

// The signer address and key ARN only: never credentials.
app.log.info(
  {
    providers: providers.map((p) => p.name),
    webOrigins: config.WEB_ORIGINS,
    signer: signing?.signer.address ?? null,
    signerKind: signing?.signer.kind ?? null,
    kmsKeyArn: signing?.signer instanceof KmsSigner ? signing.signer.keyArn : null,
    balanceChains: [...rpc.endpoints.keys()].filter((id) => reader.canRead(id)),
  },
  'quote service configured',
);

app.listen({ port: config.PORT, host: config.HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

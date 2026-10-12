import { KMSClient } from '@aws-sdk/client-kms';
import { AssumeReturningWallets } from './adapters/history/assume-returning.js';
import { DefiLlamaPriceOracle } from './adapters/prices/defillama.js';
import { awsKmsTransport, KmsSigner } from './adapters/signers/kms.js';
import { ZeroXProvider } from './adapters/providers/zero-x.js';
import { loadConfig } from './config.js';
import { buildServer } from './http/server.js';
import type { QuoteProvider } from './ports/quote-provider.js';
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

const app = buildServer({
  providers,
  prices,
  history: new AssumeReturningWallets(),
  routePolicy: TRUSTED_ROUTERS,
  providerTimeoutMs: config.PROVIDER_TIMEOUT_MS,
  maxSlippageBps: config.MAX_SLIPPAGE_BPS,
  maxOracleDeviationBps: config.MAX_ORACLE_DEVIATION_BPS,
  logger: true,
  ...(signing ? { signing } : {}),
});

// The signer address and key ARN only: never credentials.
app.log.info(
  {
    providers: providers.map((p) => p.name),
    signer: signing?.signer.address ?? null,
    signerKind: signing?.signer.kind ?? null,
    kmsKeyArn: signing?.signer instanceof KmsSigner ? signing.signer.keyArn : null,
  },
  'quote service configured',
);

app.listen({ port: config.PORT, host: config.HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

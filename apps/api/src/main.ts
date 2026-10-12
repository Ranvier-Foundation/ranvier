import { AssumeReturningWallets } from './adapters/history/assume-returning.js';
import { DefiLlamaPriceOracle } from './adapters/prices/defillama.js';
import { LocalKeySigner } from './adapters/signers/local-key.js';
import { ZeroXProvider } from './adapters/providers/zero-x.js';
import { loadConfig } from './config.js';
import { buildServer } from './http/server.js';
import type { QuoteProvider } from './ports/quote-provider.js';

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

const signing =
  config.QUOTE_SIGNER_PRIVATE_KEY && config.FEE_WRAPPER_ADDRESS
    ? {
        feeWrapper: config.FEE_WRAPPER_ADDRESS as `0x${string}`,
        signer: new LocalKeySigner(config.QUOTE_SIGNER_PRIVATE_KEY as `0x${string}`),
        ttlSeconds: config.QUOTE_TTL_SECONDS,
      }
    : undefined;

const app = buildServer({
  providers,
  prices,
  history: new AssumeReturningWallets(),
  providerTimeoutMs: config.PROVIDER_TIMEOUT_MS,
  logger: true,
  ...(signing ? { signing } : {}),
});

app.log.info(
  { providers: providers.map((p) => p.name), signer: signing?.signer.address ?? null },
  'quote service configured',
);

app.listen({ port: config.PORT, host: config.HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

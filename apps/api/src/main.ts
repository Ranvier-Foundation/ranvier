import { AssumeReturningWallets } from './adapters/history/assume-returning.js';
import { DefiLlamaPriceOracle } from './adapters/prices/defillama.js';
import { assertLocalSigningChains, LocalKeySigner } from './adapters/signers/local-key.js';
import { ZeroXProvider } from './adapters/providers/zero-x.js';
import { loadConfig } from './config.js';
import { buildServer } from './http/server.js';
import type { QuoteProvider } from './ports/quote-provider.js';
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

let signing;
if (config.QUOTE_SIGNER_PRIVATE_KEY && config.FEE_WRAPPER_ADDRESS) {
  // Refuses NODE_ENV=production and any mainnet chain ID; then every chain the API quotes
  // must be signable, or startup fails here rather than at the first quote.
  const signer = new LocalKeySigner(config.QUOTE_SIGNER_PRIVATE_KEY as `0x${string}`, {
    ...(config.LOCAL_SIGNER_CHAIN_IDS ? { allowedChainIds: config.LOCAL_SIGNER_CHAIN_IDS } : {}),
  });
  assertLocalSigningChains(config.ZEROX_CHAIN_IDS, signer);
  signing = {
    feeWrapper: config.FEE_WRAPPER_ADDRESS as `0x${string}`,
    signer,
    ttlSeconds: config.QUOTE_TTL_SECONDS,
  };
}

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

app.log.info(
  { providers: providers.map((p) => p.name), signer: signing?.signer.address ?? null },
  'quote service configured',
);

app.listen({ port: config.PORT, host: config.HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

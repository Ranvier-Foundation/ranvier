/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, section 4). `pnpm harness:api` (runs with tsx).
 * Lives in `src/harness/`: excluded from the build (`dist/`), never imported by production code.
 *
 * Starts the harness API against an anvil you started and deployed per
 * docs/runbooks/local-harness.md:
 *
 *   RANVIER_ENV=harness ZEROX_CHAIN_IDS=31337 RPC_URLS_EVM_31337=http://127.0.0.1:8645 \
 *     pnpm harness:api
 *
 * It prints the loopback base URL, never a key. Ctrl-C stops it.
 */
import { pathToFileURL } from 'node:url';
import { startHarnessApi } from './start.js';

async function main(): Promise<void> {
  const api = await startHarnessApi(process.env);
  console.log(`harness API (chain 31337 only, PUBLIC anvil keys, not real funds): ${api.url}`);
  const stop = (): void => {
    void api.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}

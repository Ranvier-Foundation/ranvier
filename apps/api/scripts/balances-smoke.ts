/**
 * `pnpm --filter @ranvier/api balances:smoke [address]`: a MANUAL live check of balance reads
 * against real RPC endpoints, for every chain balances are offered on. Networked, so not part of
 * CI. Uses `RPC_URLS_EVM_<chainId>` when set, else the public development endpoints.
 *
 * Goes through the real route (`POST /v1/balances`, in process) with the real reader and service.
 * Prints chain, block number and a summary of non-zero balances for a public example address
 * (default: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045, a well-known public address). Every
 * line is passed through `scrubUrls`, and no URL is ever printed: reader log lines carry
 * endpoint labels only.
 */
import { listTokens, scrubUrls } from '@ranvier/chains';
import { formatUnits } from 'viem';
import { ViemChainReader } from '../src/adapters/rpc/viem-chain-reader.js';
import { balanceChainIds, BalanceService } from '../src/domain/balances.js';
import type { BalancesView } from '../src/http/balances.js';
import { buildServer } from '../src/http/server.js';
import { loadRpcConfig } from '../src/rpc-config.js';

const DEFAULT_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const CHAIN_IDS = [1, 8453, 42161];

const print = (line: string): void => console.log(scrubUrls(line));
const logLine =
  (level: string) =>
  (obj: Record<string, unknown>, msg: string): void =>
    print(`  [${level}] ${msg} ${JSON.stringify(obj)}`);

async function main(): Promise<number> {
  const arg = process.argv[2] ?? DEFAULT_ADDRESS;
  if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) {
    print('usage: balances:smoke [0x-address]');
    return 2;
  }
  const owner = arg.toLowerCase() as `0x${string}`;
  const chainIds = balanceChainIds(CHAIN_IDS);
  const rpc = loadRpcConfig(process.env, chainIds);
  if (rpc.publicDefaultChains.length > 0) {
    print(`using public development endpoints for chains ${rpc.publicDefaultChains.join(', ')}`);
  }
  const reader = new ViemChainReader({
    endpoints: rpc.endpoints,
    requestTimeoutMs: 5_000,
    log: { info: logLine('info'), warn: logLine('warn'), error: logLine('error') },
  });
  const service = new BalanceService({
    reader,
    servedChainIds: chainIds,
    deadlineMs: 15_000,
    cacheTtlMs: 0,
  });
  await reader.verifyEndpoints();
  const app = buildServer({
    providers: [],
    servedChainIds: chainIds,
    balances: { service, deadlineMs: 15_000 },
  });

  let failed = 0;
  for (const chainId of chainIds) {
    const chain = `evm:${chainId}` as const;
    if (!reader.canRead(chainId)) {
      print(`${chain}: no verified endpoint`);
      failed++;
      continue;
    }
    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/balances',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ chain, address: owner }),
    });
    if (res.statusCode !== 200) {
      failed++;
      print(`${chain}: FAILED (${res.statusCode} ${res.body.slice(0, 80)})`);
      continue;
    }
    const result = res.json<BalancesView>();
    const tokens = listTokens(chain);
    const nonZero: string[] = [];
    let nulls = 0;
    for (const { address, balance } of result.balances) {
      const token = tokens.find((t) => t.address === address);
      if (balance === null) nulls++;
      else if (BigInt(balance) > 0n && token) {
        nonZero.push(`${token.symbol} ${formatUnits(BigInt(balance), token.decimals)}`);
      }
    }
    print(
      `${chain}: POST /v1/balances ${res.statusCode} (${String(res.headers['cache-control'])}), ` +
        `block ${result.blockNumber}, ${result.balances.length} balances ` +
        `(${nonZero.length} non-zero, ${nulls} failed) in ${Date.now() - started} ms`,
    );
    for (const line of nonZero) print(`  ${line}`);
  }
  await app.close();
  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err: unknown) {
  // Never let a raw error (which may quote a URL) reach the default handler.
  print(`balances:smoke failed: ${err instanceof Error ? err.name : 'error'}`);
  process.exitCode = 1;
}
// The reader may hold sockets open; this is a one-shot script.
process.exit();

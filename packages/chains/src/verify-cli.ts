/**
 * `pnpm --filter @ranvier/chains verify:tokens`: re-verifies every curated token against public
 * RPCs and DefiLlama and exits non-zero on any mismatch or failed read. Opt-in and networked:
 * not part of CI. Required for every token-list change (docs/runbooks/token-list.md).
 *
 * RPC URLs come from VERIFY_RPC_EVM_<chainId> (e.g. VERIFY_RPC_EVM_1), defaulting to public
 * publicnode endpoints. They are validated before any request, and every printed line has
 * URL-looking text replaced, so a keyed URL does not end up in logs; never commit one. Each
 * RPC must report its chain's ID before any token on it is read.
 */
import type { ChainKey } from '@ranvier/types';
import { TOKEN_LIST } from './tokens.js';
import { errText, resolveRpcUrl, scrubUrls, verifyTokens, type LlamaCoin } from './verify.js';

const DEFAULT_RPCS: Readonly<Record<string, string>> = {
  'evm:1': 'https://ethereum-rpc.publicnode.com',
  'evm:8453': 'https://base-rpc.publicnode.com',
  'evm:42161': 'https://arbitrum-one-rpc.publicnode.com',
};
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;

const print = (line: string): void => console.log(scrubUrls(line));

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      last = err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw last;
}

async function main(): Promise<number> {
  // Resolve and validate every RPC URL before any request is made.
  const rpcs = new Map<ChainKey, string>();
  for (const chain of new Set(TOKEN_LIST.map((t) => t.chain))) {
    rpcs.set(chain, resolveRpcUrl(chain, process.env, DEFAULT_RPCS));
  }

  const rpc = (chain: ChainKey, method: string, params: unknown[]): Promise<string> =>
    withRetry(async () => {
      const url = rpcs.get(chain);
      if (!url) throw new Error(`no RPC for ${chain}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } };
      if (typeof body.result !== 'string') {
        throw new Error(`RPC error ${String(body.error?.message ?? 'no result')}`);
      }
      return body.result;
    });

  const llama = (ids: readonly string[]): Promise<Record<string, LlamaCoin>> =>
    withRetry(async () => {
      const res = await fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`);
      const body = (await res.json()) as { coins?: Record<string, LlamaCoin> };
      return body.coins ?? {};
    });

  const reports = await verifyTokens(TOKEN_LIST, {
    chainId: (chain) => rpc(chain, 'eth_chainId', []),
    ethCall: (chain, to, data) => rpc(chain, 'eth_call', [{ to, data }, 'latest']),
    llama,
  });
  let failed = 0;
  for (const { token, problems } of reports) {
    const label = `${token.chain} ${token.symbol.padEnd(6)} ${token.address}`;
    if (problems.length === 0) {
      print(`ok       ${label}`);
    } else {
      failed += 1;
      print(`MISMATCH ${label}`);
      for (const p of problems) print(`         - ${p}`);
    }
  }
  print(
    `\n${reports.length - failed}/${reports.length} tokens verified on ${new Date().toISOString().slice(0, 10)}` +
      (failed ? `, ${failed} with problems` : ''),
  );
  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err: unknown) {
  // Never let a raw error (which may quote a URL) reach the default handler.
  print(`verify:tokens failed: ${errText(err)}`);
  process.exitCode = 1;
}

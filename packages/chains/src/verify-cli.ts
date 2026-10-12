/**
 * `pnpm --filter @ranvier/chains verify:tokens`: re-verifies every curated token against public
 * RPCs and DefiLlama and exits non-zero on any mismatch or failed read. Opt-in and networked:
 * not part of CI. Required for every token-list change (docs/runbooks/token-list.md).
 *
 * RPC URLs come from VERIFY_RPC_EVM_<chainId> (e.g. VERIFY_RPC_EVM_1), defaulting to public
 * publicnode endpoints. URLs are never printed, so a keyed URL does not end up in logs; never
 * commit one.
 */
import type { ChainKey } from '@ranvier/types';
import { TOKEN_LIST } from './tokens.js';
import { verifyTokens, type LlamaCoin } from './verify.js';

const DEFAULT_RPCS: Readonly<Record<string, string>> = {
  'evm:1': 'https://ethereum-rpc.publicnode.com',
  'evm:8453': 'https://base-rpc.publicnode.com',
  'evm:42161': 'https://arbitrum-one-rpc.publicnode.com',
};
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;

function rpcUrl(chain: ChainKey): string {
  const fromEnv = process.env[`VERIFY_RPC_EVM_${chain.replace('evm:', '')}`]?.trim();
  const url = fromEnv || DEFAULT_RPCS[chain];
  if (!url) throw new Error(`no RPC for ${chain}; set VERIFY_RPC_EVM_<chainId>`);
  return url;
}

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

async function ethCall(chain: ChainKey, to: string, data: string): Promise<string> {
  return withRetry(async () => {
    const res = await fetch(rpcUrl(chain), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } };
    if (typeof body.result !== 'string') {
      throw new Error(`RPC error ${String(body.error?.message ?? 'no result')}`);
    }
    return body.result;
  });
}

async function llama(ids: readonly string[]): Promise<Record<string, LlamaCoin>> {
  return withRetry(async () => {
    const res = await fetch(`https://coins.llama.fi/prices/current/${ids.join(',')}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`);
    const body = (await res.json()) as { coins?: Record<string, LlamaCoin> };
    return body.coins ?? {};
  });
}

const reports = await verifyTokens(TOKEN_LIST, { ethCall, llama });
let failed = 0;
for (const { token, problems } of reports) {
  const label = `${token.chain} ${token.symbol.padEnd(6)} ${token.address}`;
  if (problems.length === 0) {
    console.log(`ok       ${label}`);
  } else {
    failed += 1;
    console.log(`MISMATCH ${label}`);
    for (const p of problems) console.log(`         - ${p}`);
  }
}
console.log(
  `\n${reports.length - failed}/${reports.length} tokens verified on ${new Date().toISOString().slice(0, 10)}` +
    (failed ? `, ${failed} with problems` : ''),
);
process.exitCode = failed === 0 ? 0 : 1;

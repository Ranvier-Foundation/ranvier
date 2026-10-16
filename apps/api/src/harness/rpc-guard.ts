/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, section 4).
 * Lives in `src/harness/`: excluded from the build (`dist/`), never imported by production code.
 *
 * The harness signs with PUBLIC anvil keys, so it must never reach a real network. Two checks, in
 * this order, before any client exists:
 *
 * 1. `assertLoopbackRpcUrl`, with no network access at all: the URL must be exactly
 *    `http://127.0.0.1:<port>` or `http://[::1]:<port>`. No `localhost` (DNS can point it
 *    elsewhere), no other spelling of loopback, no credentials, path, query or fragment, no https
 *    (a TLS endpoint is a remote one). Anything else is refused even if it would answer 31337,
 *    because 31337 is not reserved and public chains have used it.
 * 2. `verifyLocalChain`: one read-only `eth_chainId`, redirects refused, must answer 31337.
 *
 * Every signed transaction also carries EIP-155 chain ID 31337, so it is valid on no other chain.
 */
/** A refusal: the harness sends nothing to this endpoint. */
export class HarnessRpcRefusedError extends Error {
  override readonly name = 'HarnessRpcRefusedError';
}

/** The environment variable the smoke reads its RPC URL from. */
export const RPC_URL_ENV = 'RANVIER_HARNESS_RPC_URL';

const LOOPBACK_RPC = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/;

/** The owner's development web server; the harness never talks to it (runbook, "Ports"). */
const OWNER_DEV_PORT = 3000;

/** `eth_chainId` of the local chain. A literal: never derived from data (PR 3 review, M1). */
export const LOCAL_CHAIN_ID_HEX = '0x7a69'; // 31337

/**
 * Returns the URL without a trailing slash, or throws `HarnessRpcRefusedError`. Pure: it never
 * touches the network, so a refused URL receives no request at all.
 */
export function assertLoopbackRpcUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new HarnessRpcRefusedError(
      `${RPC_URL_ENV} is not set: use http://127.0.0.1:<port> of a local anvil (chain 31337)`,
    );
  }
  const match = LOOPBACK_RPC.exec(raw);
  const port = match ? Number(match[2]) : NaN;
  if (!match || port > 65_535) {
    throw new HarnessRpcRefusedError(
      'harness RPC must be exactly http://127.0.0.1:<port> or http://[::1]:<port>; refusing ' +
        'any other host, scheme or form (PUBLIC anvil keys must never reach a real network)',
    );
  }
  if (port === OWNER_DEV_PORT) {
    throw new HarnessRpcRefusedError('port 3000 is the owner dev server, never an anvil');
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

export interface VerifyOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Asks the (already loopback-checked) endpoint for its chain ID, read-only, and refuses anything
 * but 31337. Redirects are refused, so a loopback proxy cannot hand the request on.
 */
export async function verifyLocalChain(url: string, opts: VerifyOptions = {}): Promise<void> {
  const checked = assertLoopbackRpcUrl(url);
  const doFetch = opts.fetch ?? fetch;
  let body: unknown;
  try {
    const res = await doFetch(checked, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err);
    throw new HarnessRpcRefusedError(`eth_chainId failed on the harness RPC: ${why}`);
  }
  const result =
    typeof body === 'object' && body !== null && 'result' in body ? body.result : undefined;
  if (typeof result !== 'string' || result.toLowerCase() !== LOCAL_CHAIN_ID_HEX) {
    throw new HarnessRpcRefusedError(
      `harness RPC answered chain ID ${String(result)}, not 31337 (${LOCAL_CHAIN_ID_HEX}); refusing`,
    );
  }
}

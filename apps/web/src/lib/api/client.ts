import type { ChainKey } from '@ranvier/types';
import { parseQuote, parseQuoteError, type ApiQuote, type QuoteAsk } from './quote';
import {
  parseBalances,
  parseChains,
  parseTokens,
  type ApiBalances,
  type ApiChain,
  type ApiToken,
} from './schemas';

/**
 * The browser's only network access besides the wallet: the Ranvier API at the origin baked into
 * the build (`RANVIER_BUILD_API_ORIGIN`, validated by next.config.ts and the same value that went
 * into the CSP `connect-src`). It never talks to an RPC provider (ADR 0008, ADR 0009).
 */

export type ApiErrorKind = 'unconfigured' | 'network' | 'timeout' | 'http' | 'content' | 'invalid';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** A stable error code from a closed set the caller allows (never text from the API). */
  readonly code: string | undefined;
  constructor(kind: ApiErrorKind, status?: number, code?: string) {
    // Fixed text only: a response body, URL or address never ends up in an error message.
    super(
      `API request failed: ${kind}${status === undefined ? '' : ` ${status}`}${code === undefined ? '' : ` ${code}`}`,
    );
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** Longest answer read: 100 tokens are about 25 KB; anything near this is not our API. */
export const MAX_RESPONSE_CHARS = 262_144;
export const REQUEST_TIMEOUT_MS = 8_000;

export interface ApiClientOptions {
  /** Origin of the API; empty means this build has none. Tests pass their own. */
  origin?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const BUILD_ORIGIN: string = process.env.RANVIER_BUILD_API_ORIGIN ?? '';

/** True when this build knows where the API is. */
export function apiConfigured(origin: string = BUILD_ORIGIN): boolean {
  return origin !== '';
}

async function readCapped(res: Response, maxChars: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new ApiError('content');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length > maxChars) {
        await reader.cancel();
        throw new ApiError('content');
      }
    }
    out += decoder.decode();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof TypeError) throw new ApiError('content');
    throw err;
  }
  return out;
}

/** Longest error answer read (they are a few dozen bytes; a `no_route` lists the providers). */
const MAX_ERROR_CHARS = 8_192;

async function errorCode(
  res: Response,
  parseError: ((json: unknown) => string | undefined) | undefined,
): Promise<string | undefined> {
  if (!parseError) return undefined;
  const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return undefined;
  try {
    return parseError(JSON.parse(await readCapped(res, MAX_ERROR_CHARS)));
  } catch {
    return undefined;
  }
}

interface Request<T> {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  parse: (json: unknown) => T;
  /**
   * Reads the stable code out of an error answer (a non-200 JSON body, capped like any answer).
   * It returns a code from a closed set or `undefined`; nothing else of the body is kept.
   */
  parseError?: (json: unknown) => string | undefined;
  /** Aborts the request. A caller that aborts gets the `AbortError` back, never an `ApiError`. */
  signal: AbortSignal;
}

async function request<T>(opts: ApiClientOptions, req: Request<T>): Promise<T> {
  const origin = opts.origin ?? BUILD_ORIGIN;
  if (!apiConfigured(origin)) throw new ApiError('unconfigured');
  const url = new URL(req.path, origin);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([req.signal, timeout]);
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(url, {
      method: req.method,
      headers: {
        accept: 'application/json',
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      signal,
      mode: 'cors',
      // No cookies or HTTP auth to the API, no Referer, no redirects: a redirect would send the
      // request (and a wallet address in a POST body) somewhere the CSP never approved.
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      // Balances are per wallet: never from a browser cache. Lists use the API's cache headers.
      cache: req.method === 'POST' ? 'no-store' : 'default',
    });
    if (res.status !== 200) {
      throw new ApiError('http', res.status, await errorCode(res, req.parseError));
    }
    const type = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') throw new ApiError('content');
    const body = await readCapped(res, MAX_RESPONSE_CHARS);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ApiError('content');
    }
    try {
      return req.parse(json);
    } catch {
      throw new ApiError('invalid');
    }
  } catch (err) {
    if (req.signal.aborted) throw req.signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (err instanceof ApiError) throw err;
    if (timeout.aborted) throw new ApiError('timeout');
    throw new ApiError('network');
  }
}

/** True for the error a caller's own abort produces (a stale request), which is never shown. */
export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function fetchChains(signal: AbortSignal, opts: ApiClientOptions = {}): Promise<ApiChain[]> {
  return request(opts, { method: 'GET', path: '/v1/chains', parse: parseChains, signal });
}

export function fetchTokens(
  chain: ChainKey,
  query: string,
  signal: AbortSignal,
  opts: ApiClientOptions = {},
): Promise<ApiToken[]> {
  return request(opts, {
    method: 'GET',
    path: '/v1/tokens',
    query: { chain, ...(query === '' ? {} : { q: query }), limit: '100' },
    parse: (json) => parseTokens(json, chain),
    signal,
  });
}

/** The wallet's address is sent in the POST body, never in a URL (ADR 0009). */
export function fetchBalances(
  chain: ChainKey,
  address: string,
  signal: AbortSignal,
  opts: ApiClientOptions = {},
): Promise<ApiBalances> {
  return request(opts, {
    method: 'POST',
    path: '/v1/balances',
    body: { chain, address },
    parse: (json) => parseBalances(json, chain, address),
    signal,
  });
}

/**
 * Asks for a quote. The wallet address (`taker`) is in the POST body only, never in a URL, and the
 * answer is never cached. Only the tokens' `{ chain, address }`, the amount, the taker and the
 * slippage are sent (the API refuses anything else). The answer is parsed for display and checked
 * against what was asked (ADR 0011); an error answer carries only a stable code.
 */
export function fetchQuote(
  ask: QuoteAsk,
  signal: AbortSignal,
  opts: ApiClientOptions = {},
): Promise<ApiQuote> {
  return request(opts, {
    method: 'POST',
    path: '/v1/quotes',
    body: {
      sellToken: { chain: ask.sellToken.chain, address: ask.sellToken.address },
      buyToken: { chain: ask.buyToken.chain, address: ask.buyToken.address },
      sellAmount: ask.sellAmount.toString(),
      taker: ask.taker,
      slippageBps: ask.slippageBps,
    },
    parse: (json) => parseQuote(json, ask),
    parseError: parseQuoteError,
    signal,
  });
}

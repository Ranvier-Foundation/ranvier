import type { QuoteRequest } from '@ranvier/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { PriceOracle } from '../ports/price-oracle.js';
import { ProviderError } from '../ports/provider-error.js';
import { closeAll, loopback } from '../testing/loopback.js';
import { DefiLlamaPriceOracle, PriceUnavailableError } from './prices/defillama.js';
import { ZeroXProvider } from './providers/zero-x.js';

/**
 * Outbound calls to 0x and DefiLlama never follow a redirect (real loopback servers, Node's real
 * fetch). Across origins Node's fetch strips only `Authorization`, so following one would send
 * the `0x-api-key` header, and the request, to whatever host the redirect names.
 */

const KEY = 'zerox-SECRET-key-123';
const req: QuoteRequest = {
  sellToken: { chain: 'evm:1', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  buyToken: { chain: 'evm:1', address: '0x6b175474e89094c44da98b954eedeac495271d0f' },
  sellAmount: 10n ** 18n,
  taker: '0x00000000000000000000000000000000000000aa',
  slippageBps: 50,
};
const prices: PriceOracle = { price: async () => ({ decimals: 18, usdE18: 10n ** 18n }) };

afterEach(closeAll);

async function servers(status: number) {
  const unexpected = async () => ({ status: 200, body: '{}' });
  const target = await loopback(unexpected);
  const upstream = await loopback(unexpected);
  upstream.behaviour = { kind: 'redirect', status, location: `${target.url}stolen` };
  return { upstream, target, base: upstream.url.replace(/\/$/, '') };
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe.each([301, 302, 307, 308])('an upstream answering %i', (status) => {
  it('0x: refused as upstream_error; the target never sees the request or the key', async () => {
    const { upstream, target, base } = await servers(status);
    const provider = new ZeroXProvider({
      apiKey: KEY,
      feeWrapper: '0x00000000000000000000000000000000000fee01',
      chainIds: [1],
      prices,
      baseUrl: base,
    });
    const err = await rejection(provider.quote(req, AbortSignal.timeout(5_000)));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('upstream_error');
    expect(err.message).toBe('0x redirect refused');
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]?.headers['0x-api-key']).toBe(KEY);
    expect(target.received).toEqual([]);
  });

  it('DefiLlama: refused as no price; the target never sees the request', async () => {
    const { upstream, target, base } = await servers(status);
    const oracle = new DefiLlamaPriceOracle({ baseUrl: base });
    const err = await rejection(oracle.price(req.buyToken, AbortSignal.timeout(5_000)));
    expect(err).toBeInstanceOf(PriceUnavailableError);
    expect(err.message).toBe('DefiLlama redirect refused');
    expect(upstream.received).toHaveLength(1);
    expect(target.received).toEqual([]);
  });
});

describe('a 3xx that a fetch did not follow', () => {
  const redirectFetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://elsewhere.example/' },
    })) as typeof fetch;

  it('is still refused by both adapters', async () => {
    const provider = new ZeroXProvider({
      apiKey: KEY,
      feeWrapper: '0x00000000000000000000000000000000000fee01',
      chainIds: [1],
      prices,
      fetch: redirectFetch,
    });
    expect((await rejection(provider.quote(req, AbortSignal.timeout(1_000)))).message).toBe(
      '0x redirect refused',
    );
    const oracle = new DefiLlamaPriceOracle({ fetch: redirectFetch });
    expect((await rejection(oracle.price(req.buyToken, AbortSignal.timeout(1_000)))).message).toBe(
      'DefiLlama redirect refused',
    );
  });

  it('passes other fetch failures through unchanged', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const provider = new ZeroXProvider({
      apiKey: KEY,
      feeWrapper: '0x00000000000000000000000000000000000fee01',
      chainIds: [1],
      prices,
      fetch: failing,
    });
    expect((await rejection(provider.quote(req, AbortSignal.timeout(1_000)))).message).toBe(
      'fetch failed',
    );
    const oracle = new DefiLlamaPriceOracle({ fetch: failing });
    expect((await rejection(oracle.price(req.buyToken, AbortSignal.timeout(1_000)))).message).toBe(
      'fetch failed',
    );
  });
});

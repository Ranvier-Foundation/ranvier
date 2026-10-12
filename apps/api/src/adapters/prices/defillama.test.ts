import { describe, expect, it } from 'vitest';
import type { TokenRef } from '@ranvier/types';
import { usdCents } from '../../domain/usd.js';
import { DefiLlamaPriceOracle, PriceUnavailableError, type DefiLlamaOptions } from './defillama.js';

const NOW = 1_800_000_000_000;
const E18 = 10n ** 18n;
const USDC: TokenRef = { chain: 'evm:1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' };
/** A token the registry does not list: DefiLlama is its only source of decimals. */
const OTHER: TokenRef = { chain: 'evm:1', address: '0x1111111111111111111111111111111111111111' };
const ETH: TokenRef = { chain: 'evm:1', address: 'native' };
const WETH_ID = 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC_ID = `ethereum:${USDC.address}`;
const OTHER_ID = `ethereum:${OTHER.address}`;

type Opts = Omit<DefiLlamaOptions, 'fetch' | 'now'>;

/** `body` is sent verbatim, so tests control the exact JSON number text. */
function setupRaw(body: string | (() => Response), status = 200, opts: Opts = {}) {
  const urls: string[] = [];
  let now = NOW;
  const fetchStub = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return typeof body === 'function' ? body() : new Response(body, { status });
  }) as typeof fetch;
  const oracle = new DefiLlamaPriceOracle({ fetch: fetchStub, now: () => now, ...opts });
  return { oracle, urls, advance: (ms: number) => (now += ms) };
}

const fresh = { timestamp: NOW / 1000 - 60, confidence: 0.99 };
const setup = (coins: Record<string, unknown>, status = 200, opts: Opts = {}) =>
  setupRaw(JSON.stringify({ coins }), status, opts);
const signal = () => AbortSignal.timeout(1000);
const rawCoin = (id: string, price: string, decimals = 18) =>
  `{"coins":{"${id}":{"price":${price},"decimals":${decimals},"timestamp":${fresh.timestamp},"confidence":0.99}}}`;

describe('DefiLlamaPriceOracle', () => {
  it('returns trusted decimals and an exact 1e18-scaled price', async () => {
    const { oracle } = setup({ [USDC_ID]: { price: 0.9998, decimals: 6, ...fresh } });
    const price = await oracle.price(USDC, signal());
    expect(price).toEqual({ decimals: 6, usdE18: 999_800_000_000_000_000n });
    expect(usdCents(price, 1_000n * 10n ** 6n)).toBe(99_980n);
  });

  it('prices the native coin through its wrapped token with registry decimals', async () => {
    // DefiLlama's decimals for the wrapped token are ignored for the native coin.
    const { oracle, urls } = setup({ [WETH_ID]: { price: 2500.5, decimals: 0, ...fresh } });
    const price = await oracle.price(ETH, signal());
    expect(price).toEqual({ decimals: 18, usdE18: 2_500_500_000_000_000_000_000n });
    expect(usdCents(price, 2n * E18)).toBe(500_100n);
    expect(urls[0]).toBe(`https://coins.llama.fi/prices/current/${WETH_ID}`);
  });

  it('uses the registry for Solana native decimals (9)', async () => {
    const id = 'solana:So11111111111111111111111111111111111111112';
    const { oracle } = setup({ [id]: { price: 111.25, ...fresh } });
    const price = await oracle.price({ chain: 'solana:mainnet', address: 'native' }, signal());
    expect(price.decimals).toBe(9);
  });

  it('refuses DefiLlama decimals that disagree with the registry (wrong oracle decimals)', async () => {
    for (const decimals of [0, 18, 36]) {
      const { oracle } = setup({ [USDC_ID]: { price: 1, decimals, ...fresh } });
      await expect(oracle.price(USDC, signal()), String(decimals)).rejects.toThrow(
        'decimals mismatch',
      );
    }
    const weth = { chain: 'evm:1' as const, address: WETH_ID.slice('ethereum:'.length) };
    const { oracle } = setup({ [WETH_ID]: { price: 2500, decimals: 6, ...fresh } });
    await expect(oracle.price(weth, signal())).rejects.toThrow('decimals mismatch');
  });

  it('trusts DefiLlama decimals for tokens the registry does not list', async () => {
    const { oracle } = setup({ [OTHER_ID]: { price: 2, decimals: 8, ...fresh } });
    expect(await oracle.price(OTHER, signal())).toEqual({ decimals: 8, usdE18: 2n * E18 });
  });

  it('converts tiny and huge prices without floats', async () => {
    const cases: [string, bigint][] = [
      ['0.00000042', 420_000_000_000n],
      ['1e-7', 100_000_000_000n],
      ['4.2e-7', 420_000_000_000n],
      ['0.12345678901234567891', 123_456_789_012_345_678n],
      ['123456789012345678901234567890', 123_456_789_012_345_678_901_234_567_890n * E18],
    ];
    for (const [text, usdE18] of cases) {
      const { oracle } = setupRaw(rawCoin(OTHER_ID, text));
      expect((await oracle.price(OTHER, signal())).usdE18, text).toBe(usdE18);
    }
  });

  it('rejects zero, negative and sub-1e-18 prices', async () => {
    for (const price of ['0', '-1', '1e-19', '0.0']) {
      const { oracle } = setupRaw(rawCoin(USDC_ID, price, 6));
      await expect(oracle.price(USDC, signal()), price).rejects.toThrow(PriceUnavailableError);
    }
  });

  it('rejects absurd exponents', async () => {
    const { oracle } = setupRaw(rawCoin(USDC_ID, '1e200', 6));
    await expect(oracle.price(USDC, signal())).rejects.toThrow('unparseable price');
  });

  it('refuses tokens without decimals, or with decimals outside 0..36', async () => {
    const { oracle } = setup({ [OTHER_ID]: { price: 1, ...fresh } });
    await expect(oracle.price(OTHER, signal())).rejects.toThrow('no decimals');
    for (const decimals of [37, -1, 1.5]) {
      const bad = setup({ [OTHER_ID]: { price: 1, decimals, ...fresh } });
      await expect(bad.oracle.price(OTHER, signal())).rejects.toThrow('malformed');
    }
  });

  it('refuses prices without a confidence score', async () => {
    const { timestamp } = fresh;
    const { oracle } = setup({ [USDC_ID]: { price: 1, decimals: 6, timestamp } });
    await expect(oracle.price(USDC, signal())).rejects.toThrow('malformed');
    const native = setup({ [WETH_ID]: { price: 2500, decimals: 18, timestamp } });
    await expect(native.oracle.price(ETH, signal())).rejects.toThrow('malformed');
  });

  it('caches prices briefly', async () => {
    const { oracle, urls, advance } = setup({ [USDC_ID]: { price: 1, decimals: 6, ...fresh } });
    await oracle.price(USDC, signal());
    await oracle.price(USDC, signal());
    expect(urls).toHaveLength(1);
    advance(30_000);
    await oracle.price(USDC, signal());
    expect(urls).toHaveLength(2);
  });

  it('caches failures for a short time only', async () => {
    const { oracle, urls, advance } = setup({});
    await expect(oracle.price(USDC, signal())).rejects.toThrow('no price');
    await expect(oracle.price(USDC, signal())).rejects.toThrow('no price');
    expect(urls).toHaveLength(1);
    advance(10_000);
    await expect(oracle.price(USDC, signal())).rejects.toThrow('no price');
    expect(urls).toHaveLength(2);
  });

  it('does not cache aborted lookups', async () => {
    let calls = 0;
    const { oracle } = setupRaw(() => {
      calls++;
      if (calls === 1) throw new DOMException('aborted', 'AbortError');
      return new Response(
        JSON.stringify({ coins: { [USDC_ID]: { price: 1, decimals: 6, ...fresh } } }),
      );
    });
    await expect(oracle.price(USDC, signal())).rejects.toThrow('aborted');
    expect((await oracle.price(USDC, signal())).decimals).toBe(6);
  });

  it('merges identical concurrent lookups into one request', async () => {
    const { oracle, urls } = setup({ [USDC_ID]: { price: 1, decimals: 6, ...fresh } });
    const results = await Promise.all([1, 2, 3].map(() => oracle.price(USDC, signal())));
    expect(results.map((r) => r.decimals)).toEqual([6, 6, 6]);
    expect(urls).toHaveLength(1);
  });

  it('evicts the least recently used entry when full', async () => {
    const coins = {
      [USDC_ID]: { price: 1, decimals: 6, ...fresh },
      [WETH_ID]: { price: 2500, decimals: 18, ...fresh },
      [OTHER_ID]: { price: 2, decimals: 8, ...fresh },
    };
    const { oracle, urls } = setupRaw(JSON.stringify({ coins }), 200, { maxCacheEntries: 2 });
    await oracle.price(USDC, signal());
    await oracle.price(ETH, signal());
    await oracle.price(USDC, signal()); // cached; USDC is now most recently used
    await oracle.price(OTHER, signal()); // evicts ETH, not USDC
    await oracle.price(USDC, signal()); // still cached
    expect(urls).toHaveLength(3);
    await oracle.price(ETH, signal()); // fetched again
    expect(urls).toHaveLength(4);
  });

  it('keeps at least one cache entry', async () => {
    const { oracle, urls } = setup({ [USDC_ID]: { price: 1, decimals: 6, ...fresh } }, 200, {
      maxCacheEntries: 0,
    });
    await oracle.price(USDC, signal());
    await oracle.price(USDC, signal());
    expect(urls).toHaveLength(1);
  });

  it('refuses response bodies over the size cap', async () => {
    const big = JSON.stringify({
      coins: { [USDC_ID]: { price: 1, decimals: 6, ...fresh } },
      pad: 'x'.repeat(70_000),
    });
    const streamed = setupRaw(big);
    await expect(streamed.oracle.price(USDC, signal())).rejects.toThrow('too large');
    const declared = setupRaw(
      () => new Response('{}', { headers: { 'content-length': String(1_000_000) } }),
    );
    await expect(declared.oracle.price(USDC, signal())).rejects.toThrow('too large');
    const small = setupRaw(
      JSON.stringify({ coins: { [USDC_ID]: { price: 1, decimals: 6, ...fresh } } }),
      200,
      {
        maxBodyBytes: 10,
      },
    );
    await expect(small.oracle.price(USDC, signal())).rejects.toThrow('too large');
  });

  it('treats an empty body as malformed', async () => {
    const { oracle } = setupRaw(() => new Response(null, { status: 200 }));
    await expect(oracle.price(USDC, signal())).rejects.toThrow('unparseable');
  });

  it('URL-encodes path components', async () => {
    const { oracle, urls } = setup({});
    await expect(
      oracle.price({ chain: 'evm:1', address: '0xab/../../x?y#z' }, signal()),
    ).rejects.toBeInstanceOf(PriceUnavailableError);
    expect(urls[0]).toBe(
      'https://coins.llama.fi/prices/current/ethereum:0xab%2F..%2F..%2Fx%3Fy%23z',
    );
  });

  it('rejects stale, low-confidence, missing, malformed and failed prices', async () => {
    const cases = [
      setup({ [USDC_ID]: { price: 1, decimals: 6, ...fresh, timestamp: NOW / 1000 - 3600 } }),
      setup({ [USDC_ID]: { price: 1, decimals: 6, ...fresh, confidence: 0.5 } }),
      setup({}),
      setup({}, 503),
      setupRaw('{"coins":{"x":{"price":"1"}}}'),
      // A price sent as a JSON string is not a JSON number and is refused.
      setupRaw(
        `{"coins":{"${USDC_ID}":{"price":"1","decimals":6,"timestamp":${fresh.timestamp},"confidence":1}}}`,
      ),
      setupRaw('not json'),
    ];
    for (const { oracle } of cases) {
      await expect(oracle.price(USDC, signal())).rejects.toBeInstanceOf(PriceUnavailableError);
    }
  });

  it('rejects unknown chains', async () => {
    const { oracle } = setup({});
    await expect(oracle.price({ ...USDC, chain: 'evm:999' }, signal())).rejects.toBeInstanceOf(
      PriceUnavailableError,
    );
  });
});

import { describe, expect, it } from 'vitest';
import type { TokenRef } from '@ranvier/types';
import { usdCents } from '../../domain/usd.js';
import { DefiLlamaPriceOracle, PriceUnavailableError } from './defillama.js';

const NOW = 1_800_000_000_000;
const E18 = 10n ** 18n;
const USDC: TokenRef = { chain: 'evm:1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' };
const ETH: TokenRef = { chain: 'evm:1', address: 'native' };
const WETH_ID = 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC_ID = `ethereum:${USDC.address}`;

/** `body` is sent verbatim, so tests control the exact JSON number text. */
function setupRaw(body: string, status = 200, opts: { maxCacheEntries?: number } = {}) {
  const urls: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(body, { status });
  }) as typeof fetch;
  const oracle = new DefiLlamaPriceOracle({ fetch: fetchStub, now: () => NOW, ...opts });
  return { oracle, urls };
}

const fresh = { timestamp: NOW / 1000 - 60, confidence: 0.99 };
const setup = (coins: Record<string, unknown>, status = 200) =>
  setupRaw(JSON.stringify({ coins }), status);
const signal = () => AbortSignal.timeout(1000);

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

  it('converts tiny and huge prices without floats', async () => {
    const raw = (p: string) =>
      `{"coins":{"${USDC_ID}":{"price":${p},"decimals":18,"timestamp":${fresh.timestamp}}}}`;
    const cases: [string, bigint][] = [
      ['0.00000042', 420_000_000_000n],
      ['1e-7', 100_000_000_000n],
      ['4.2e-7', 420_000_000_000n],
      ['0.12345678901234567891', 123_456_789_012_345_678n],
      ['123456789012345678901234567890', 123_456_789_012_345_678_901_234_567_890n * E18],
    ];
    for (const [text, usdE18] of cases) {
      const { oracle } = setupRaw(raw(text));
      expect((await oracle.price(USDC, signal())).usdE18, text).toBe(usdE18);
    }
  });

  it('rejects zero, negative and sub-1e-18 prices', async () => {
    for (const price of ['0', '-1', '1e-19', '0.0']) {
      const { oracle } = setupRaw(
        `{"coins":{"${USDC_ID}":{"price":${price},"decimals":6,"timestamp":${fresh.timestamp}}}}`,
      );
      await expect(oracle.price(USDC, signal()), price).rejects.toThrow(PriceUnavailableError);
    }
  });

  it('rejects absurd exponents', async () => {
    const { oracle } = setupRaw(
      `{"coins":{"${USDC_ID}":{"price":1e200,"decimals":6,"timestamp":${fresh.timestamp}}}}`,
    );
    await expect(oracle.price(USDC, signal())).rejects.toThrow('unparseable price');
  });

  it('refuses tokens without trusted decimals', async () => {
    const { oracle } = setup({ [USDC_ID]: { price: 1, ...fresh } });
    await expect(oracle.price(USDC, signal())).rejects.toThrow('no decimals');
    const bad = setup({ [USDC_ID]: { price: 1, decimals: 37, ...fresh } });
    await expect(bad.oracle.price(USDC, signal())).rejects.toThrow('malformed');
  });

  it('caches prices briefly', async () => {
    const { oracle, urls } = setup({ [USDC_ID]: { price: 1, decimals: 6, ...fresh } });
    await oracle.price(USDC, signal());
    await oracle.price(USDC, signal());
    expect(urls).toHaveLength(1);
  });

  it('bounds the cache, evicting the oldest entry', async () => {
    const coins = {
      [USDC_ID]: { price: 1, decimals: 6, ...fresh },
      [WETH_ID]: { price: 2500, decimals: 18, ...fresh },
    };
    const { oracle, urls } = setupRaw(JSON.stringify({ coins }), 200, { maxCacheEntries: 1 });
    await oracle.price(USDC, signal());
    await oracle.price(ETH, signal()); // evicts USDC
    await oracle.price(ETH, signal()); // cached
    await oracle.price(USDC, signal()); // fetched again
    expect(urls).toHaveLength(3);
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
      setup({ [USDC_ID]: { price: 1, decimals: 6, timestamp: NOW / 1000 - 3600 } }),
      setup({ [USDC_ID]: { price: 1, decimals: 6, ...fresh, confidence: 0.5 } }),
      setup({}),
      setup({}, 503),
      setupRaw('{"coins":{"x":{"price":"1"}}}'),
      // A price sent as a JSON string is not a JSON number and is refused.
      setupRaw(
        `{"coins":{"${USDC_ID}":{"price":"1","decimals":6,"timestamp":${fresh.timestamp}}}}`,
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

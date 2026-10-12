import { describe, expect, it } from 'vitest';
import type { Token } from '@ranvier/types';
import { DefiLlamaPriceOracle, PriceUnavailableError } from './defillama.js';

const NOW = 1_800_000_000_000;
const USDC: Token = {
  chain: 'evm:1',
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  symbol: 'USDC',
  decimals: 6,
};
const ETH: Token = { chain: 'evm:1', address: 'native', symbol: 'ETH', decimals: 18 };

function setup(coins: Record<string, unknown>, status = 200) {
  const urls: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ coins }), { status });
  }) as typeof fetch;
  const oracle = new DefiLlamaPriceOracle({ fetch: fetchStub, now: () => NOW });
  return { oracle, urls };
}

const fresh = { timestamp: NOW / 1000 - 60, confidence: 0.99 };
const signal = () => AbortSignal.timeout(1000);

describe('DefiLlamaPriceOracle', () => {
  it('values amounts in integer cents', async () => {
    const { oracle } = setup({ [`ethereum:${USDC.address}`]: { price: 0.9998, ...fresh } });
    expect(await oracle.usdValue(USDC, 1_000n * 10n ** 6n, signal())).toBe(99_980n);
  });

  it('prices the native token through its wrapped address', async () => {
    const id = 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const { oracle, urls } = setup({ [id]: { price: 2500.5, ...fresh } });
    expect(await oracle.usdValue(ETH, 2n * 10n ** 18n, signal())).toBe(500_100n);
    expect(urls[0]).toBe(`https://coins.llama.fi/prices/current/${id}`);
  });

  it('caches prices briefly', async () => {
    const { oracle, urls } = setup({ [`ethereum:${USDC.address}`]: { price: 1, ...fresh } });
    await oracle.usdValue(USDC, 1n, signal());
    await oracle.usdValue(USDC, 1n, signal());
    expect(urls).toHaveLength(1);
  });

  it('rejects stale, low-confidence, missing and failed prices', async () => {
    const id = `ethereum:${USDC.address}`;
    const cases = [
      setup({ [id]: { price: 1, timestamp: NOW / 1000 - 3600, confidence: 0.99 } }),
      setup({ [id]: { price: 1, ...fresh, confidence: 0.5 } }),
      setup({}),
      setup({}, 503),
    ];
    for (const { oracle } of cases) {
      await expect(oracle.usdValue(USDC, 1n, signal())).rejects.toBeInstanceOf(
        PriceUnavailableError,
      );
    }
  });

  it('rejects unknown chains', async () => {
    const { oracle } = setup({});
    await expect(
      oracle.usdValue({ ...USDC, chain: 'evm:999' }, 1n, signal()),
    ).rejects.toBeInstanceOf(PriceUnavailableError);
  });
});

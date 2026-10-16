import { NATIVE } from '@ranvier/chains';
import type { QuoteRequest } from '@ranvier/types';
import { describe, expect, it } from 'vitest';
import { buildRoutePolicy } from '../../src/domain/route-policy.js';
import { UnsafeRouteError, vetRoute } from '../../src/domain/route-safety.js';
import { FixedPriceOracle, HarnessQuoteProvider } from './fixtures.js';
import { PINNED } from './pinned.js';

const TAKER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const policy = buildRoutePolicy({
  31337: [
    { kind: 'zerox-allowance-holder', address: PINNED.allowanceHolder, targets: [PINNED.settler] },
  ],
});
const provider = new HarnessQuoteProvider();
const oracle = new FixedPriceOracle();
const signal = (): AbortSignal => AbortSignal.timeout(1_000);

function req(sell: string, buy: string, sellAmount: bigint, chain = 'evm:31337'): QuoteRequest {
  const addr = (a: string): string => (a === NATIVE ? NATIVE : a.toLowerCase());
  return {
    sellToken: { chain: chain as QuoteRequest['sellToken']['chain'], address: addr(sell) },
    buyToken: { chain: chain as QuoteRequest['buyToken']['chain'], address: addr(buy) },
    sellAmount,
    taker: TAKER,
    slippageBps: 50,
  };
}

async function vet(request: QuoteRequest) {
  const [sellPrice, buyPrice] = await Promise.all([
    oracle.price(request.sellToken, signal()),
    oracle.price(request.buyToken, signal()),
  ]);
  const route = await provider.quote(request, signal());
  return vetRoute({ request, sellPrice, buyPrice, policy, maxOracleDeviationBps: 500 }, route);
}

describe('harness provider answers the shape vetRoute checks', () => {
  it.each([
    [PINNED.hWETH, PINNED.hUSDC, 998n * 10n ** 15n, 2_994_000_000n],
    [NATIVE, PINNED.hUSDC, 10n ** 18n, 3_000_000_000n],
    [PINNED.hUSDC, NATIVE, 3_000_000_000n, 10n ** 18n],
    [PINNED.hUSDC, PINNED.hUNDER, 998_000_000n, 998_000_000n],
  ])('%s -> %s passes', async (sell, buy, amount, out) => {
    const route = await vet(req(sell, buy, amount));
    expect(route.buyAmount).toBe(out);
    expect(route.tx.value).toBe(sell === NATIVE ? amount : 0n);
  });

  it('the 90% pair is refused below_oracle_value', async () => {
    await expect(vet(req(PINNED.hUSDC, PINNED.hORACLE, 998_000_000n))).rejects.toMatchObject({
      reason: 'below_oracle_value',
    });
    await expect(vet(req(PINNED.hUSDC, PINNED.hORACLE, 1n))).rejects.toBeInstanceOf(
      UnsafeRouteError,
    );
  });

  it('refuses every chain but 31337 and unknown pairs', async () => {
    const base = req(PINNED.hWETH, PINNED.hUSDC, 1n, 'evm:8453');
    expect(provider.supports(base)).toBe(false);
    await expect(provider.quote(base, signal())).rejects.toThrow();
    await expect(oracle.price(base.sellToken, signal())).rejects.toThrow();
    expect(provider.supports(req(PINNED.hUSDC, PINNED.hUSDC, 1n))).toBe(false);
  });
});

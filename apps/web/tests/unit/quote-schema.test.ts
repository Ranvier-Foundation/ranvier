import { FEE_SCHEDULE } from '@ranvier/fees';
import { describe, expect, it } from 'vitest';
import { parseQuote, parseQuoteError } from '../../src/lib/api/quote';
import { SchemaError } from '../../src/lib/api/schemas';
import { QUOTE_TTL_MAX_SECONDS, QUOTE_TTL_MIN_SECONDS } from '../../src/lib/swap/config';
import {
  ASK,
  SECRETS,
  TIMING_ECHO,
  TAKER,
  USDC,
  WRAP_ASK,
  ZERO,
  swapAnswer,
  wrapAnswer,
} from './helpers/quote-fixtures';

const refuse = (answer: unknown, ask = ASK) =>
  expect(() => parseQuote(answer, ask)).toThrow(SchemaError);

describe('parseQuote: a routed swap', () => {
  it('reads only what the screen shows', () => {
    const q = parseQuote(swapAnswer(), ASK);
    expect(q).toEqual({
      kind: 'swap',
      buyAmount: 124_750_000n,
      minBuyAmount: 124_126_250n,
      buyUsdCents: 12_475n,
      networkCostUsdCents: 31n,
      provider: '0x',
      routeCount: 2,
      fee: { bps: 20, reason: 'tier-under-10k', amount: 100_000_000_000_000n, waivedUsdCents: 0n },
      deadlineSec: 1_790_000_060n,
      serverTimeSec: 1_790_000_000,
      ttlSeconds: 60,
    });
  });

  it('drops the calldata, the signature, the signed transaction and everything else it does not show', () => {
    const q = parseQuote(swapAnswer(), ASK);
    const kept = JSON.stringify(q, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    for (const secret of SECRETS) expect(kept, secret).not.toContain(secret);
    // Nothing but the display fields, by key.
    expect(Object.keys(q).sort()).toEqual(
      [
        'buyAmount',
        'buyUsdCents',
        'deadlineSec',
        'fee',
        'kind',
        'minBuyAmount',
        'networkCostUsdCents',
        'provider',
        'routeCount',
        'serverTimeSec',
        'ttlSeconds',
      ].sort(),
    );
    expect(Object.keys(q.fee).sort()).toEqual(['amount', 'bps', 'reason', 'waivedUsdCents']);
    // A field the API adds later is not picked up either.
    const withExtra = parseQuote(swapAnswer({ top: { tx: '0xEXTRA', extra: 1 } }), ASK);
    expect(Object.keys(withExtra)).toEqual(Object.keys(q));
  });

  it('accepts native out and a token in (the zero address stands for the native coin)', () => {
    const ask = {
      ...ASK,
      sellToken: { chain: 'evm:1' as const, address: USDC },
      buyToken: { chain: 'evm:1' as const, address: 'native' },
      sellAmount: 100_000_000n,
    };
    const answer = swapAnswer({
      fee: { amount: String((100_000_000n * 20n) / 10_000n) },
      quote: {
        tokenIn: USDC,
        tokenOut: ZERO,
        amountIn: '100000000',
        feeAmount: String((100_000_000n * 20n) / 10_000n),
      },
    });
    expect(parseQuote(answer, ask).kind).toBe('swap');
  });

  describe('the answer must echo what was asked', () => {
    it.each([
      ['another taker', { quote: { user: '0x1111111111111111111111111111111111112222' } }],
      ['another sell token', { quote: { tokenIn: USDC } }],
      ['another buy token', { quote: { tokenOut: '0x6b175474e89094c44da98b954eedeac495271d0f' } }],
      ['another sell amount', { quote: { amountIn: '50000000000000001' } }],
      ['a signed fee that differs from the fee shown', { quote: { feeAmount: '1' } }],
      [
        'a signed minimum that differs from the one shown',
        { quote: { minAmountOut: '124126251' } },
      ],
    ])('refuses %s', (_name, over) => {
      refuse(swapAnswer(over));
    });

    it('compares the taker without case', () => {
      expect(parseQuote(swapAnswer({ quote: { user: TAKER } }), ASK).kind).toBe('swap');
      expect(
        parseQuote(swapAnswer(), { ...ASK, taker: TAKER.toUpperCase().replace('0X', '0x') }).kind,
      ).toBe('swap');
    });

    it('refuses an answer for another request even when it is internally consistent', () => {
      refuse(swapAnswer(), { ...ASK, sellAmount: 60_000_000_000_000_000n });
      refuse(swapAnswer(), {
        ...ASK,
        buyToken: { chain: 'evm:1', address: '0x' + '1'.repeat(40) },
      });
    });
  });

  describe('the fee must be one the schedule can produce', () => {
    it('refuses a rate above the contract cap, and one the schedule has no tier for', () => {
      refuse(swapAnswer({ fee: { bps: FEE_SCHEDULE.maxBps + 1 } }));
      refuse(swapAnswer({ fee: { bps: 21 } }));
      refuse(swapAnswer({ fee: { bps: 0 } }));
      refuse(swapAnswer({ fee: { bps: 20.5 } }));
      refuse(swapAnswer({ fee: { bps: '20' } }));
    });

    it('refuses a reason that does not match its rate', () => {
      refuse(swapAnswer({ fee: { reason: 'stablecoin' } })); // 20 bps is not the stablecoin rate
      refuse(swapAnswer({ fee: { reason: 'tier-10k-100k' } }));
      refuse(swapAnswer({ fee: { reason: 'something-else' } }));
    });

    it('refuses an amount other than the rate gives', () => {
      refuse(
        swapAnswer({ fee: { amount: '100000000000001' }, quote: { feeAmount: '100000000000001' } }),
      );
      refuse(swapAnswer({ fee: { amount: '0' }, quote: { feeAmount: '0' } }));
    });

    it('refuses a wrap fee reason on a routed swap, and a waiver without the promo reason', () => {
      refuse(
        swapAnswer({
          fee: { reason: 'wrap-unwrap', bps: 0, amount: '0' },
          quote: { feeAmount: '0' },
        }),
      );
      refuse(swapAnswer({ fee: { waivedUsd: '100' } }));
    });

    it('accepts the first-swap waiver: a smaller or zero amount, the waived USD, the usual rate', () => {
      const promo = swapAnswer({
        fee: { reason: 'first-swap-promo', amount: '0', waivedUsd: '12475' },
        quote: { feeAmount: '0' },
      });
      const q = parseQuote(promo, ASK);
      expect(q.fee).toEqual({
        bps: 20,
        reason: 'first-swap-promo',
        amount: 0n,
        waivedUsdCents: 12_475n,
      });
      // More than the rate allows is refused, and so is a waiver above the cap, or none at all.
      refuse(
        swapAnswer({
          fee: { reason: 'first-swap-promo', amount: '100000000000001', waivedUsd: '12475' },
          quote: { feeAmount: '100000000000001' },
        }),
      );
      refuse(
        swapAnswer({
          fee: {
            reason: 'first-swap-promo',
            amount: '0',
            waivedUsd: String(FEE_SCHEDULE.firstSwapFreeUsd + 1n),
          },
          quote: { feeAmount: '0' },
        }),
      );
      refuse(
        swapAnswer({
          fee: { reason: 'first-swap-promo', amount: '0', waivedUsd: '0' },
          quote: { feeAmount: '0' },
        }),
      );
    });
  });

  describe('shape', () => {
    it('is one of a routed swap or a direct wrap, never both and never neither', () => {
      refuse(swapAnswer({ top: { direct: wrapAnswer().direct } }));
      const unsigned = swapAnswer();
      delete unsigned['swap'];
      refuse(unsigned);
      refuse({ fee: swapAnswer()['fee'] });
    });

    it.each([
      ['not an object', null],
      ['an array', []],
      ['a string', '{}'],
      ['no fee', { ...swapAnswer(), fee: undefined }],
      ['a fee that is not an object', { ...swapAnswer(), fee: 'free' }],
    ])('refuses %s', (_n, answer) => refuse(answer));

    it.each([
      ['buy amount as a number', { best: { buyAmount: 124750000 } }],
      ['buy amount negative', { best: { buyAmount: '-1' } }],
      ['buy amount with a leading zero', { best: { buyAmount: '0124750000' } }],
      ['buy amount with a decimal point', { best: { buyAmount: '124.75' } }],
      ['buy amount of zero', { best: { buyAmount: '0' } }],
      ['buy amount above uint256', { best: { buyAmount: (2n ** 256n).toString() } }],
      ['minimum above the buy amount', { best: { minBuyAmount: '124750001' } }],
      ['minimum of zero', { best: { minBuyAmount: '0' } }],
      ['gas cost missing', { best: { gasCostUsd: undefined } }],
      ['gas cost as a float', { best: { gasCostUsd: '0.31' } }],
      ['USD value missing', { best: { buyAmountUsd: undefined } }],
      ['provider empty', { best: { provider: '' } }],
      ['provider with a bidi override', { best: { provider: '0x‮' } }],
      ['provider with a newline', { best: { provider: '0x\nspoof' } }],
      ['provider too long', { best: { provider: 'x'.repeat(33) } }],
      ['provider padded', { best: { provider: ' 0x' } }],
      ['provider not a string', { best: { provider: { toString: (): string => '0x' } } }],
      ['deadline as a number', { quote: { deadline: 1790000060 } }],
      ['deadline of zero', { quote: { deadline: '0' } }],
      ['deadline not digits', { quote: { deadline: '1e9' } }],
      ['no quotes listed', { top: { quotes: [] } }],
      ['too many quotes', { top: { quotes: Array.from({ length: 17 }, () => ({})) } }],
      ['quotes not a list', { top: { quotes: { length: 3 } } }],
    ])('refuses %s', (_n, over) => refuse(swapAnswer(over)));

    it('renders a provider name that looks like markup as the text it is', () => {
      const q = parseQuote(swapAnswer({ best: { provider: '<b onload=x>' } }), ASK);
      expect(q.kind === 'swap' && q.provider).toBe('<b onload=x>');
    });
  });
});

/** cbBTC has one address on Ethereum and Base; the native coin is `native` on every chain. */
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const CBBTC_FEE = String((100_000_000n * 20n) / 10_000n);

/** Sell 1 cbBTC for the native coin on `chain`, and the answer for it, built for `chain`. */
function cbbtcOn(chain: 'evm:1' | 'evm:8453') {
  const ask = {
    ...ASK,
    sellToken: { chain, address: CBBTC },
    buyToken: { chain, address: 'native' },
    sellAmount: 100_000_000n,
  };
  const id = chain === 'evm:1' ? 1 : 8453;
  const answer = (top: Record<string, unknown> = {}) =>
    swapAnswer({
      fee: { amount: CBBTC_FEE },
      quote: { tokenIn: CBBTC, tokenOut: ZERO, amountIn: '100000000', feeAmount: CBBTC_FEE },
      top: { sellChain: chain, buyChain: chain, chainId: id, ...top },
    });
  return { ask, answer };
}

describe('parseQuote: the answer must be for the chain that was asked (ADR 0012, B1)', () => {
  it('accepts an answer that echoes the chain it was asked for', () => {
    expect(parseQuote(swapAnswer(), ASK).kind).toBe('swap');
    expect(parseQuote(wrapAnswer(), WRAP_ASK).kind).toBe('wrap');
    const base = cbbtcOn('evm:8453');
    expect(parseQuote(base.answer(), base.ask).kind).toBe('swap');
  });

  it.each([
    ['sellChain of another chain', { sellChain: 'evm:8453' }],
    ['buyChain of another chain', { buyChain: 'evm:8453' }],
    [
      "both chains of another chain, with that chain's number",
      { sellChain: 'evm:8453', buyChain: 'evm:8453', chainId: 8453 },
    ],
    ['a chainId of another chain', { chainId: 8453 }],
    ['a chainId one off', { chainId: 2 }],
    ['a chainId of zero', { chainId: 0 }],
    ['a chainId as text', { chainId: '1' }],
    ['a chainId with a fraction', { chainId: 1.5 }],
    ['a chainId of null', { chainId: null }],
    ['a sellChain that differs only in case', { sellChain: 'EVM:1' }],
    ['a sellChain with padding', { sellChain: ' evm:1' }],
    ['a buyChain that is a number', { buyChain: 1 }],
    ['a sellChain that is an object that prints as the key', { sellChain: ['evm:1'] }],
  ])('refuses a routed answer with %s', (_n, top) => {
    refuse(swapAnswer({ top }));
  });

  it.each(['sellChain', 'buyChain', 'chainId'])('refuses a routed answer with no %s', (field) => {
    refuse(swapAnswer({ top: { [field]: undefined } }));
  });

  it('takes the number of a chain from the registry, not from the answer', () => {
    // An answer for Base that says chainId 1: the key says Base, the number says Ethereum.
    const base = cbbtcOn('evm:8453');
    refuse(base.answer({ chainId: 1 }), base.ask);
    // The same for an Ethereum request answered with Base's key and number: still not asked for.
    refuse(swapAnswer({ top: { sellChain: 'evm:8453', buyChain: 'evm:8453', chainId: 8453 } }));
    // A chain the registry does not list has no number to compare with: refused whatever it says.
    const unknown = {
      ...ASK,
      sellToken: { chain: 'evm:999999' as const, address: 'native' },
      buyToken: { chain: 'evm:999999' as const, address: USDC },
    };
    refuse(
      swapAnswer({ top: { sellChain: 'evm:999999', buyChain: 'evm:999999', chainId: 999999 } }),
      unknown,
    );
    // So is a request on two chains (the API signs same-chain swaps only).
    const cross = {
      ...ASK,
      buyToken: { chain: 'evm:8453' as const, address: USDC },
    };
    refuse(swapAnswer({ top: { buyChain: 'evm:8453' } }), cross);
  });

  describe('tokens with one address on several chains', () => {
    it('cbBTC asked on Ethereum, answered for Base (same token address, same native zero address)', () => {
      const eth = cbbtcOn('evm:1');
      const base = cbbtcOn('evm:8453');
      // Every token, amount and fee check passes for both answers; only the chain tells them apart.
      expect(parseQuote(eth.answer(), eth.ask).kind).toBe('swap');
      refuse(base.answer(), eth.ask);
      // A half-hearted lie: Base's key with Ethereum's number, or the reverse.
      refuse(eth.answer({ chainId: 8453 }), eth.ask);
      refuse(eth.answer({ sellChain: 'evm:8453', buyChain: 'evm:8453' }), eth.ask);
    });

    it('cbBTC asked on Base, answered for Ethereum', () => {
      const eth = cbbtcOn('evm:1');
      const base = cbbtcOn('evm:8453');
      expect(parseQuote(base.answer(), base.ask).kind).toBe('swap');
      refuse(eth.answer(), base.ask);
    });

    it('the native coin sold on Ethereum, answered for Base or Arbitrum', () => {
      refuse(swapAnswer({ top: { sellChain: 'evm:8453', buyChain: 'evm:8453', chainId: 8453 } }));
      refuse(
        swapAnswer({ top: { sellChain: 'evm:42161', buyChain: 'evm:42161', chainId: 42161 } }),
      );
    });

    it('a wrap asked on Ethereum, answered for another chain', () => {
      refuse(
        wrapAnswer({ top: { sellChain: 'evm:8453', buyChain: 'evm:8453', chainId: 8453 } }),
        WRAP_ASK,
      );
      refuse(wrapAnswer({ top: { chainId: 8453 } }), WRAP_ASK);
    });
  });
});

describe('parseQuote: the timing of a signed answer (ADR 0012, M1)', () => {
  const { serverTime } = TIMING_ECHO;
  /** A consistent answer for a lifetime: the deadline is serverTime + ttl, as the API writes it. */
  const withTtl = (ttlSeconds: number) =>
    swapAnswer({
      top: { ttlSeconds },
      quote: { deadline: String(serverTime + ttlSeconds) },
    });

  it('reads serverTime and ttlSeconds, and the deadline equals their sum', () => {
    const q = parseQuote(swapAnswer(), ASK);
    expect(q.kind === 'swap' && [q.serverTimeSec, q.ttlSeconds, q.deadlineSec]).toEqual([
      1_790_000_000,
      60,
      1_790_000_060n,
    ]);
  });

  it('accepts the documented lifetimes at and between the bounds', () => {
    for (const ttl of [QUOTE_TTL_MIN_SECONDS, 30, 60, QUOTE_TTL_MAX_SECONDS]) {
      const q = parseQuote(withTtl(ttl), ASK);
      expect(q.kind === 'swap' && q.ttlSeconds).toBe(ttl);
    }
  });

  it("keeps the bounds at the API's documented range, named once in config", () => {
    expect([QUOTE_TTL_MIN_SECONDS, QUOTE_TTL_MAX_SECONDS]).toEqual([10, 600]);
  });

  it.each([
    ['ttl 9 (one under the minimum)', 9],
    ['ttl 601 (one over the maximum)', 601],
    ['ttl 0', 0],
    ['ttl negative', -60],
    ['ttl with a fraction', 60.5],
    ['ttl as text', '60'],
    ['ttl NaN-like null', null],
    ['ttl above the safe integers', 2 ** 53],
  ])('refuses %s, even with a deadline that matches it', (_n, ttl) => {
    const deadline = typeof ttl === 'number' ? String(serverTime + ttl) : '1790000060';
    refuse(swapAnswer({ top: { ttlSeconds: ttl }, quote: { deadline } }));
  });

  it.each([
    ['serverTime with a fraction', 1_790_000_000.5],
    ['serverTime as text', '1790000000'],
    ['serverTime of zero', 0],
    ['serverTime negative', -1],
    ['serverTime null', null],
    ['serverTime beyond the safe integers', 2 ** 53],
    ['serverTime that is not finite', Infinity],
  ])('refuses %s', (_n, value) => {
    refuse(swapAnswer({ top: { serverTime: value } }));
  });

  it.each(['serverTime', 'ttlSeconds'])('refuses a signed answer with no %s', (field) => {
    refuse(swapAnswer({ top: { [field]: undefined } }));
  });

  it('refuses a deadline off by one, either way', () => {
    refuse(swapAnswer({ quote: { deadline: '1790000061' } }));
    refuse(swapAnswer({ quote: { deadline: '1790000059' } }));
    // The signed deadline is compared exactly, as a bigint: a huge one cannot round into a match.
    refuse(swapAnswer({ quote: { deadline: '9007199254740993' } }));
  });

  it('refuses a serverTime off by one, with the deadline left as it was', () => {
    refuse(swapAnswer({ top: { serverTime: serverTime + 1 } }));
    refuse(swapAnswer({ top: { serverTime: serverTime - 1 } }));
  });

  it('refuses a ttl off by one, with the deadline left as it was', () => {
    refuse(swapAnswer({ top: { ttlSeconds: 61 } }));
    refuse(swapAnswer({ top: { ttlSeconds: 59 } }));
  });

  it('a direct wrap has no lifetime: timing fields on one are refused, and none are needed', () => {
    expect(parseQuote(wrapAnswer(), WRAP_ASK).kind).toBe('wrap');
    refuse(wrapAnswer({ top: { serverTime } }), WRAP_ASK);
    refuse(wrapAnswer({ top: { ttlSeconds: 60 } }), WRAP_ASK);
  });

  it('a wrap needs the chain echo and refuses without it', () => {
    for (const field of ['sellChain', 'buyChain', 'chainId']) {
      refuse(wrapAnswer({ top: { [field]: undefined } }), WRAP_ASK);
    }
  });

  it('fields the API may add later are still ignored', () => {
    const q = parseQuote(swapAnswer({ top: { somethingNew: { a: 1 } } }), ASK);
    expect(q.kind).toBe('swap');
  });
});

describe('parseQuote: the minimum and the amount shown (a check no other check covers)', () => {
  // The signed floor is made to agree with the shown one, so only the minimum <= amount and
  // non-zero rule can refuse these: the signed-quote cross-check passes.
  it('refuses a minimum above the amount, when the signed floor says the same', () => {
    refuse(
      swapAnswer({ best: { minBuyAmount: '124750001' }, quote: { minAmountOut: '124750001' } }),
    );
  });

  it('refuses a minimum of zero, when the signed floor says zero too', () => {
    refuse(swapAnswer({ best: { minBuyAmount: '0' }, quote: { minAmountOut: '0' } }));
  });

  it('refuses an amount of zero, when the minimum and the signed floor are zero too', () => {
    refuse(
      swapAnswer({
        best: { buyAmount: '0', minBuyAmount: '0' },
        quote: { minAmountOut: '0' },
      }),
    );
  });

  it('accepts a minimum equal to the amount (no slippage room is still a quote)', () => {
    const q = parseQuote(
      swapAnswer({ best: { minBuyAmount: '124750000' }, quote: { minAmountOut: '124750000' } }),
      ASK,
    );
    expect(q.kind === 'swap' && q.minBuyAmount).toBe(124_750_000n);
  });
});

describe('parseQuote: a direct wrap or unwrap', () => {
  it('reads the amounts and the free fee, nothing else', () => {
    const q = parseQuote(wrapAnswer(), WRAP_ASK);
    expect(q).toEqual({
      kind: 'wrap',
      direction: 'wrap',
      buyAmount: 50_000_000_000_000_000n,
      minBuyAmount: 50_000_000_000_000_000n,
      fee: { bps: 0, reason: 'wrap-unwrap', amount: 0n, waivedUsdCents: 0n },
    });
    expect(
      JSON.stringify(q, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain('d0e30db0');
  });

  it('unwraps when the wrapped token is sold', () => {
    const ask = { ...ASK, sellToken: WRAP_ASK.buyToken, buyToken: ASK.sellToken };
    expect(parseQuote(wrapAnswer({ direct: { kind: 'unwrap' } }), ask).kind).toBe('wrap');
    refuse(wrapAnswer(), ask); // says "wrap" for a sold WETH
  });

  it.each([
    ['an output other than the sell amount', { direct: { buyAmount: '49999999999999999' } }],
    ['a minimum other than the sell amount', { direct: { minBuyAmount: '1' } }],
    ['a kind that is neither', { direct: { kind: 'swap' } }],
    [
      'a fee that is not free',
      { fee: { bps: 20, reason: 'tier-under-10k', amount: '100000000000000' } },
    ],
    ['a free fee with another reason', { fee: { reason: 'stablecoin' } }],
  ])('refuses %s', (_n, over) => refuse(wrapAnswer(over), WRAP_ASK));
});

describe('parseQuoteError: only a stable code, never text from the API', () => {
  it.each([
    ['invalid_request', 'invalid_request'],
    ['price_unavailable', 'price_unavailable'],
    ['routing_unavailable', 'routing_unavailable'],
    ['signing_unavailable', 'signing_unavailable'],
    ['internal_error', 'internal_error'],
  ])('%s', (code, expected) => {
    expect(parseQuoteError({ error: code, message: 'ignored <script>' })).toBe(expected);
  });

  it('no_route is routing_slow only when every provider timed out or failed upstream', () => {
    expect(parseQuoteError({ error: 'no_route', failures: [] })).toBe('no_route');
    expect(parseQuoteError({ error: 'no_route' })).toBe('no_route');
    expect(
      parseQuoteError({ error: 'no_route', failures: [{ provider: '0x', error: 'no_liquidity' }] }),
    ).toBe('no_route');
    expect(
      parseQuoteError({
        error: 'no_route',
        failures: [
          { provider: '0x', error: 'timeout' },
          { provider: 'b', error: 'upstream_error' },
        ],
      }),
    ).toBe('routing_slow');
    expect(
      parseQuoteError({
        error: 'no_route',
        failures: [
          { provider: '0x', error: 'timeout' },
          { provider: 'b', error: 'rejected_unsafe_route' },
        ],
      }),
    ).toBe('no_route');
  });

  it.each([null, [], 'no_route', { error: 'teapot' }, { error: 5 }, { error: '__proto__' }, {}])(
    'ignores %j',
    (body) => expect(parseQuoteError(body)).toBeUndefined(),
  );
});

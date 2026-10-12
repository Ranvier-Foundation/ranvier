import { describe, expect, it } from 'vitest';
import type { ProviderQuote, QuoteRequest, TokenRef } from '@ranvier/types';
import { padHex, recoverTypedDataAddress, type Hex } from 'viem';
import { KmsSigner } from '../adapters/signers/kms.js';
import { LocalKeySigner } from '../adapters/signers/local-key.js';
import { ZEROX_NATIVE_IN } from '../domain/allowance-holder.js';
import { buildRoutePolicy } from '../domain/route-policy.js';
import { signedMinimum, slippageFloor } from '../domain/route-safety.js';
import { typedData } from '../domain/swap-quote.js';
import type { PriceOracle, TokenPrice } from '../ports/price-oracle.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import { SigningUnavailableError } from '../ports/quote-signer.js';
import { FAKE_ALIAS, FakeKms } from '../testing/fake-kms.js';
import { ALLOWANCE_HOLDER, ATTACKER, SETTLER, zeroXRoute } from '../testing/zero-x-route.js';
import { buildServer, type ServerDeps } from './server.js';

const E18 = 10n ** 18n;
const ETH = { chain: 'evm:1', address: 'native' };
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDC = { chain: 'evm:1', address: USDC_ADDRESS };
const DAI = { chain: 'evm:1', address: '0x6b175474e89094c44da98b954eedeac495271d0f' };
const WETH = { chain: 'evm:1', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' };
const BASE_WETH = { chain: 'evm:8453', address: '0x4200000000000000000000000000000000000006' };
// Base Sepolia, for signed quotes: a local key never signs for a mainnet.
const TESTNET_ETH = { chain: 'evm:84532', address: 'native' };
const TESTNET_USDC = { chain: 'evm:84532', address: USDC_ADDRESS };
const TAKER = '0x00000000000000000000000000000000000000aa';
const ZERO_FEE = { bps: 0, reason: 'wrap-unwrap', amount: '0', waivedUsd: '0' };
const POLICY = buildRoutePolicy(
  Object.fromEntries(
    [1, 8453, 84532].map((id) => [
      id,
      [{ kind: 'zerox-allowance-holder' as const, address: ALLOWANCE_HOLDER, targets: [SETTLER] }],
    ]),
  ),
);
const signer = () => new LocalKeySigner(padHex('0xa11ce', { size: 32 }), { nodeEnv: 'test' });
const SIGNING = {
  feeWrapper: '0x000000000000000000000000000000000000fee1',
  signer: signer(),
  ttlSeconds: 60,
  now: () => 1_800_000_000_000,
  nonce: () => 9n,
} as const;
const quoteBody = {
  sellToken: ETH,
  buyToken: USDC,
  sellAmount: '1000000000000000000',
  taker: TAKER,
  slippageBps: 50,
};

/** Trusted test prices: native $2,000 (18 decimals), USDC and DAI $1 (6 and 18 decimals). */
function oracle(ethUsd = 2_000n, calls: TokenRef[] = []): PriceOracle {
  return {
    price: async (token): Promise<TokenPrice> => {
      calls.push(token);
      if (token.address === 'native') return { decimals: 18, usdE18: ethUsd * E18 };
      if (token.address === USDC_ADDRESS) return { decimals: 6, usdE18: E18 };
      if (token.address === DAI.address) return { decimals: 18, usdE18: E18 };
      throw new Error(`no price for ${token.address}`);
    },
  };
}

/** An honest 0x-like provider: fair output at the oracle price, consistent calldata. */
function honestProvider(
  ethUsd = 2_000n,
  tamper: (req: QuoteRequest) => Partial<Parameters<typeof zeroXRoute>[1]> = () => ({}),
  calls: QuoteRequest[] = [],
): QuoteProvider {
  return {
    name: 'fake',
    supports: () => true,
    quote: async (req): Promise<ProviderQuote> => {
      calls.push(req);
      const nativeIn = req.sellToken.address === 'native';
      const buyAmount = (req.sellAmount * ethUsd) / 10n ** 12n; // wei -> USDC base units
      return {
        ...zeroXRoute(
          {
            operator: SETTLER,
            token: nativeIn ? ZEROX_NATIVE_IN : (req.sellToken.address as Hex),
            amount: req.sellAmount,
            target: SETTLER,
            recipient: req.taker as Hex,
            buyToken: req.buyToken.address as Hex,
            minAmountOut: 0n,
          },
          {
            buyAmount,
            minBuyAmount: slippageFloor(buyAmount, req.slippageBps),
            value: nativeIn ? req.sellAmount : 0n,
            ...tamper(req),
          },
        ),
        provider: 'fake',
        buyAmountUsd: 2_000_00n,
        gasCostUsd: 50n,
      };
    },
  };
}

const deps = (overrides: Partial<ServerDeps> = {}): ServerDeps => ({
  providers: [honestProvider()],
  prices: oracle(),
  history: { hasCompletedSwap: async () => true },
  routePolicy: POLICY,
  ...overrides,
});

const post = (d: ServerDeps, payload: unknown, url = '/v1/quotes') =>
  buildServer(d).inject({ method: 'POST', url, payload: payload as Record<string, unknown> });

describe('http', () => {
  it('reports health', async () => {
    const res = await buildServer(deps()).inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('previews fees with bigint amounts as strings', async () => {
    const res = await post(
      deps(),
      { sellToken: ETH, buyToken: USDC, sellAmount: '1000000', usdValueCents: '500000' },
      '/v1/fees/preview',
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      bps: 20,
      reason: 'tier-under-10k',
      amount: '2000',
      waivedUsd: '0',
    });
  });

  it('rejects invalid input with a stable code and field paths only', async () => {
    const preview = await post(deps(), { sellAmount: '-1' }, '/v1/fees/preview');
    expect(preview.statusCode).toBe(400);
    expect(preview.json().error).toBe('invalid_request');
    const zero = await post(deps(), { ...quoteBody, sellAmount: '0' });
    expect(zero.statusCode).toBe(400);
    expect(zero.json()).toEqual({ error: 'invalid_request', fields: ['sellAmount'] });
    const several = await post(deps(), {
      ...quoteBody,
      sellToken: { chain: 'evm:1', address: 'nope' },
      slippageBps: 99_999,
    });
    expect(several.json()).toEqual({
      error: 'invalid_request',
      fields: ['sellToken.address', 'slippageBps'],
    });
    expect(several.body).not.toContain('message');
    const body = await post(deps(), []);
    expect(body.json()).toEqual({ error: 'invalid_request', fields: ['(body)'] });
  });

  it('rejects non-canonical EVM chain keys at the edge', async () => {
    const calls: TokenRef[] = [];
    const d = deps({ prices: oracle(2_000n, calls) });
    for (const chain of [
      'evm:01',
      'evm:0',
      'evm:-1',
      'evm:1.5',
      'evm:',
      'evm:1e3',
      'evm:12345678901',
    ]) {
      const res = await post(d, {
        ...quoteBody,
        sellToken: { chain, address: 'native' },
        buyToken: { chain, address: USDC_ADDRESS },
      });
      expect(res.statusCode, chain).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('returns 503 when routing is not configured', async () => {
    expect((await post({ providers: [] }, quoteBody)).statusCode).toBe(503);
    expect((await post(deps({ routePolicy: undefined as never }), quoteBody)).statusCode).toBe(503);
  });

  it('takes the fee before quoting and returns the best route', async () => {
    const res = await post(deps(), quoteBody);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fee).toEqual({
      bps: 20,
      reason: 'tier-under-10k',
      amount: '2000000000000000',
      waivedUsd: '0',
    });
    expect(body.best.tx.value).toBe('998000000000000000');
  });

  it('applies the first-swap promo for new wallets', async () => {
    const res = await post(
      deps({
        providers: [honestProvider(500n)],
        prices: oracle(500n),
        history: { hasCompletedSwap: async () => false },
      }),
      quoteBody,
    );
    expect(res.json().fee.reason).toBe('first-swap-promo');
  });

  it('charges a first swap only on the part above $1,000', async () => {
    const res = await post(
      deps({
        providers: [honestProvider(1_500n)],
        prices: oracle(1_500n),
        history: { hasCompletedSwap: async () => false },
      }),
      quoteBody,
    );
    // 1 ETH worth $1,500: 0.2% on the $500 above the waiver = 1/3 ETH * 0.002, rounded down.
    expect(res.json().fee).toEqual({
      bps: 20,
      reason: 'first-swap-promo',
      amount: '666666666666666',
      waivedUsd: '100000',
    });
  });

  it('returns 503 when the sell or buy price is unavailable, before calling providers', async () => {
    const calls: QuoteRequest[] = [];
    const down = deps({
      providers: [honestProvider(2_000n, () => ({}), calls)],
      prices: { price: async () => Promise.reject(new Error('oracle down')) },
    });
    const res = await post(down, quoteBody);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'price_unavailable' });
    // An unpriced buy token cannot be bounded against the oracle, so nothing is quoted.
    const unknownBuy = {
      ...quoteBody,
      buyToken: { chain: 'evm:1', address: `0x${'12'.repeat(20)}` },
    };
    const res2 = await post(
      deps({ providers: [honestProvider(2_000n, () => ({}), calls)] }),
      unknownBuy,
    );
    expect(res2.statusCode).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('includes a signed fee-wrapper transaction when signing is configured', async () => {
    const res = await post(deps({ signing: SIGNING }), {
      ...quoteBody,
      sellToken: TESTNET_ETH,
      buyToken: TESTNET_USDC,
    });
    expect(res.statusCode).toBe(200);
    const { swap, best } = res.json();
    const buyAmount = (998n * 10n ** 15n * 2_000n) / 10n ** 12n;
    expect(swap.quote).toMatchObject({
      user: '0x00000000000000000000000000000000000000AA',
      tokenIn: '0x0000000000000000000000000000000000000000',
      amountIn: '1000000000000000000',
      feeAmount: '2000000000000000',
      // The vetted floor, rounded up in the user's favour.
      minAmountOut: signedMinimum(buyAmount, 50).toString(),
      nonce: '9',
      deadline: '1800000060',
    });
    expect(best.minBuyAmount).toBe(swap.quote.minAmountOut);
    expect(swap.transaction).toMatchObject({
      to: '0x000000000000000000000000000000000000fee1',
      value: '1000000000000000000',
    });
    expect(swap.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('uses a random nonce and the current time by default', async () => {
    const app = buildServer(
      deps({ signing: { feeWrapper: SIGNING.feeWrapper, signer: signer(), ttlSeconds: 60 } }),
    );
    const body = { ...quoteBody, sellToken: TESTNET_ETH, buyToken: TESTNET_USDC };
    const a = (await app.inject({ method: 'POST', url: '/v1/quotes', payload: body })).json();
    const b = (await app.inject({ method: 'POST', url: '/v1/quotes', payload: body })).json();
    expect(a.swap.quote.nonce).not.toBe(b.swap.quote.nonce);
    expect(Number(a.swap.quote.deadline)).toBeGreaterThan(Date.now() / 1000);
  });

  it('refuses to sign for a chain the signer refuses (mainnet with a local key)', async () => {
    const res = await post(deps({ signing: SIGNING }), quoteBody);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'signing_unavailable' });
  });

  describe('KMS signer (ADR 0005)', () => {
    const kmsSigning = async (chainIds = [1, 8453]) => ({
      ...SIGNING,
      signer: await KmsSigner.create({
        keyId: FAKE_ALIAS,
        transport: new FakeKms({ privateKey: padHex('0xa11ce', { size: 32 }) }),
        chainIds,
      }),
    });

    it('signs a mainnet quote with a KMS signer and a trusted router policy', async () => {
      const signing = await kmsSigning();
      const res = await post(deps({ signing }), quoteBody);
      expect(res.statusCode).toBe(200);
      const { swap } = res.json();
      expect(swap.signature).toMatch(/^0x[0-9a-f]{130}$/);
      const recovered = await recoverTypedDataAddress({
        ...typedData(
          {
            ...swap.quote,
            amountIn: BigInt(swap.quote.amountIn),
            minAmountOut: BigInt(swap.quote.minAmountOut),
            feeAmount: BigInt(swap.quote.feeAmount),
            nonce: BigInt(swap.quote.nonce),
            deadline: BigInt(swap.quote.deadline),
          },
          1,
          SIGNING.feeWrapper,
        ),
        signature: swap.signature,
      } as Parameters<typeof recoverTypedDataAddress>[0]);
      expect(recovered).toBe(signing.signer.address);
    });

    it('refuses a mainnet the KMS signer is not configured for, or without a router policy', async () => {
      const notConfigured = await post(deps({ signing: await kmsSigning([8453]) }), quoteBody);
      expect(notConfigured.statusCode).toBe(503);
      expect(notConfigured.json()).toEqual({ error: 'signing_unavailable' });
      // Policy without chain 1: no route can be vetted, so nothing reaches the signer.
      const noPolicy = await post(
        deps({ signing: await kmsSigning(), routePolicy: buildRoutePolicy({}) }),
        quoteBody,
      );
      expect(noPolicy.statusCode).toBe(502);
    });

    it('refuses a mainnet for a non-KMS signer that claims it can sign it', async () => {
      let signed = 0;
      const rogue = {
        ...SIGNING,
        signer: {
          kind: 'local-key' as const,
          address: SIGNING.signer.address,
          canSign: () => true,
          signTypedData: async (): Promise<Hex> => {
            signed++;
            return '0x';
          },
        },
      };
      const res = await post(deps({ signing: rogue }), quoteBody);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'signing_unavailable' });
      expect(signed).toBe(0);
    });

    for (const reason of ['busy', 'timeout', 'upstream', 'integrity'] as const) {
      it(`answers 503 signing_unavailable when signing fails (${reason}), without AWS details`, async () => {
        const failing = {
          ...SIGNING,
          signer: {
            kind: 'kms' as const,
            address: SIGNING.signer.address,
            canSign: () => true,
            signTypedData: async (): Promise<Hex> => {
              throw new SigningUnavailableError(
                reason,
                'AccessDeniedException: arn:aws:kms:eu-west-1:111122223333:key/secret-detail',
              );
            },
          },
        };
        const res = await post(deps({ signing: failing }), quoteBody);
        expect(res.statusCode).toBe(503);
        expect(res.body).toBe(JSON.stringify({ error: 'signing_unavailable' }));
      });
    }

    it('keeps 500 internal_error for unexpected signer errors', async () => {
      const broken = {
        ...SIGNING,
        signer: {
          kind: 'kms' as const,
          address: SIGNING.signer.address,
          canSign: () => true,
          signTypedData: async (): Promise<Hex> => {
            throw new Error('bug: AccessDeniedException detail');
          },
        },
      };
      const res = await post(deps({ signing: broken }), quoteBody);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal_error' });
    });
  });

  describe('finding 1: decimals come from the oracle, never the client', () => {
    it('rejects client-supplied decimals and symbol (exploit replay: USDC decimals 0 and 36)', async () => {
      const calls: TokenRef[] = [];
      const d = deps({ prices: oracle(2_000n, calls) });
      for (const decimals of [0, 36, 6]) {
        const res = await post(d, {
          ...quoteBody,
          sellToken: { ...USDC, symbol: 'USDC', decimals },
          buyToken: DAI,
          sellAmount: '5000000000', // $5,000 of USDC
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
      expect(calls).toHaveLength(0);
    });

    it('prices $5,000 of USDC as $5,000 (tier under $10k), whatever a client claims', async () => {
      const usdcToEth = (req: QuoteRequest) => {
        // 5,000 USDC at $2,000/ETH; the fee is taken from the input first.
        const buyAmount = (req.sellAmount * 10n ** 12n) / 2_000n;
        return {
          token: USDC_ADDRESS as Hex,
          buyToken: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Hex,
          buyAmount,
          minBuyAmount: slippageFloor(buyAmount, req.slippageBps),
          value: 0n,
        };
      };
      const res = await post(deps({ providers: [honestProvider(2_000n, usdcToEth)] }), {
        ...quoteBody,
        sellToken: USDC,
        buyToken: ETH,
        sellAmount: '5000000000',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().fee).toEqual({
        bps: 20,
        reason: 'tier-under-10k',
        amount: '10000000',
        waivedUsd: '0',
      });
    });

    it('gives a first swap of $5,000 USDC only the $1,000 waiver', async () => {
      const usdcToDai = (req: QuoteRequest) => {
        const buyAmount = req.sellAmount * 10n ** 12n;
        return {
          token: USDC_ADDRESS as Hex,
          buyToken: DAI.address as Hex,
          buyAmount,
          minBuyAmount: slippageFloor(buyAmount, req.slippageBps),
          value: 0n,
        };
      };
      const res = await post(
        deps({
          providers: [honestProvider(2_000n, usdcToDai)],
          history: { hasCompletedSwap: async () => false },
        }),
        { ...quoteBody, sellToken: USDC, buyToken: DAI, sellAmount: '5000000000' },
      );
      // Stablecoin pair, 5 bps on the $4,000 above the waiver.
      expect(res.json().fee).toEqual({
        bps: 5,
        reason: 'first-swap-promo',
        amount: '2000000',
        waivedUsd: '100000',
      });
    });
  });

  describe('finding 2: unsafe routes are refused, never signed', () => {
    const signedBody = { ...quoteBody, sellToken: TESTNET_ETH, buyToken: TESTNET_USDC };
    const cases: [string, (req: QuoteRequest) => Partial<Parameters<typeof zeroXRoute>[1]>][] = [
      ['attacker operator and target', () => ({ operator: ATTACKER, target: ATTACKER })],
      ['wrong token', () => ({ token: USDC_ADDRESS as Hex })],
      ['wrong amount', (req) => ({ amount: req.sellAmount + 1n })],
      ['minBuyAmount 0', () => ({ minBuyAmount: 0n })],
      [
        'buyAmount far below the oracle value',
        (req) => {
          const low = (req.sellAmount * 1_000n) / 10n ** 12n; // half the fair output
          return { buyAmount: low, minBuyAmount: slippageFloor(low, req.slippageBps) };
        },
      ],
      [
        'unknown target',
        () => ({ operator: `0x${'77'.repeat(20)}` as Hex, target: `0x${'77'.repeat(20)}` as Hex }),
      ],
    ];
    for (const [name, tamper] of cases) {
      it(`refuses ${name}`, async () => {
        let signed = 0;
        const spy = {
          ...SIGNING,
          signer: {
            kind: 'local-key' as const,
            address: SIGNING.signer.address,
            canSign: () => true,
            signTypedData: async (): Promise<Hex> => {
              signed++;
              return '0x';
            },
          },
        };
        const res = await post(
          deps({ providers: [honestProvider(2_000n, tamper)], signing: spy }),
          signedBody,
        );
        expect(res.statusCode).toBe(502);
        expect(res.json()).toEqual({
          error: 'no_route',
          failures: [{ provider: 'fake', error: 'rejected_unsafe_route' }],
        });
        expect(signed).toBe(0);
      });
    }

    it('caps slippageBps at 1000 by default', async () => {
      expect((await post(deps(), { ...quoteBody, slippageBps: 1_000 })).statusCode).toBe(200);
      expect((await post(deps(), { ...quoteBody, slippageBps: 1_001 })).statusCode).toBe(400);
    });

    it('honours MAX_SLIPPAGE_BPS but never above 5000', async () => {
      const wide = deps({ maxSlippageBps: 2_000 });
      expect((await post(wide, { ...quoteBody, slippageBps: 1_500 })).statusCode).toBe(200);
      const tooWide = deps({ maxSlippageBps: 9_000 });
      expect((await post(tooWide, { ...quoteBody, slippageBps: 5_000 })).statusCode).toBe(200);
      expect((await post(tooWide, { ...quoteBody, slippageBps: 5_001 })).statusCode).toBe(400);
    });

    it('applies MAX_ORACLE_DEVIATION_BPS', async () => {
      // Output 3% below the oracle value: refused at 200 bps, accepted at the default 500.
      const short = (req: QuoteRequest) => {
        const low = (req.sellAmount * 2_000n * 97n) / 100n / 10n ** 12n;
        return { buyAmount: low, minBuyAmount: slippageFloor(low, req.slippageBps) };
      };
      const p = [honestProvider(2_000n, short)];
      expect((await post(deps({ providers: p }), quoteBody)).statusCode).toBe(200);
      expect(
        (await post(deps({ providers: p, maxOracleDeviationBps: 200 }), quoteBody)).statusCode,
      ).toBe(502);
    });
  });

  describe('finding 5: addresses are validated and normalised', () => {
    it('rejects malformed token and taker addresses before any provider call', async () => {
      const calls: QuoteRequest[] = [];
      const d = deps({ providers: [honestProvider(2_000n, () => ({}), calls)] });
      const bad = [
        { ...quoteBody, buyToken: { chain: 'evm:1', address: '0xa0b8' } },
        { ...quoteBody, buyToken: { chain: 'evm:1', address: '../../prices/current/x' } },
        { ...quoteBody, sellToken: { chain: 'evm:1', address: 'NATIVE' } },
        { ...quoteBody, buyToken: { chain: 'solana:mainnet', address: '0OIl' + '1'.repeat(30) } },
        { ...quoteBody, taker: 'not-an-address' },
        { ...quoteBody, buyToken: { ...USDC, extra: 1 } },
      ];
      for (const body of bad) expect((await post(d, body)).statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('spells native only as `native`: EVM placeholders are refused on both sides', async () => {
      const priced: TokenRef[] = [];
      const quoted: QuoteRequest[] = [];
      const d = deps({
        prices: oracle(2_000n, priced),
        providers: [honestProvider(2_000n, () => ({}), quoted)],
      });
      const placeholders = [
        '0x0000000000000000000000000000000000000000',
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      ];
      for (const address of placeholders) {
        const asSell = await post(d, { ...quoteBody, sellToken: { chain: 'evm:1', address } });
        expect(asSell.json(), address).toEqual({
          error: 'invalid_request',
          fields: ['sellToken.address'],
        });
        const asBuy = await post(d, {
          ...quoteBody,
          sellToken: USDC,
          buyToken: { chain: 'evm:1', address },
        });
        expect(asBuy.json(), address).toEqual({
          error: 'invalid_request',
          fields: ['buyToken.address'],
        });
        // A placeholder can never be mistaken for WETH's wrap partner either.
        const wrap = await post(d, {
          ...quoteBody,
          sellToken: { chain: 'evm:1', address },
          buyToken: WETH,
        });
        expect(wrap.statusCode).toBe(400);
      }
      expect(priced).toHaveLength(0);
      expect(quoted).toHaveLength(0);
      // `native` still wraps directly and still routes through vetting.
      expect((await post(d, { ...quoteBody, buyToken: WETH })).json().direct.kind).toBe('wrap');
      expect((await post(d, quoteBody)).json().best.provider).toBe('fake');
    });

    it('accepts Solana tokens and takers in base58', async () => {
      const res = await post(
        deps({ prices: { price: async () => Promise.reject(new Error('x')) } }),
        {
          ...quoteBody,
          sellToken: { chain: 'solana:mainnet', address: 'native' },
          buyToken: {
            chain: 'solana:mainnet',
            address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          },
          taker: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        },
      );
      expect(res.statusCode).toBe(503); // valid request; no Solana price in this test
    });

    it('lowercases EVM taker and token addresses before swap history and providers', async () => {
      const wallets: string[] = [];
      const calls: QuoteRequest[] = [];
      const res = await post(
        deps({
          providers: [honestProvider(2_000n, () => ({}), calls)],
          history: {
            hasCompletedSwap: async (w) => {
              wallets.push(w);
              return true;
            },
          },
        }),
        {
          ...quoteBody,
          buyToken: { chain: 'evm:1', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
          taker: '0x00000000000000000000000000000000000000AA',
        },
      );
      expect(res.statusCode).toBe(200);
      expect(wallets).toEqual([TAKER]);
      expect(calls[0]?.taker).toBe(TAKER);
      expect(calls[0]?.buyToken.address).toBe(USDC_ADDRESS);
    });
  });

  describe('finding 6: clients get stable codes, never upstream details', () => {
    it('returns provider failures as codes only', async () => {
      const res = await post(
        deps({
          providers: [
            {
              name: 'down',
              supports: () => true,
              quote: async () => Promise.reject(new Error('0x said: key abc123 invalid')),
            },
          ],
        }),
        quoteBody,
      );
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: 'no_route',
        failures: [{ provider: 'down', error: 'upstream_error' }],
      });
      expect(res.body).not.toContain('abc123');
    });

    it('logs non-Error rejections without leaking them', async () => {
      const res = await post(
        deps({
          providers: [
            { name: 'odd', supports: () => true, quote: async () => Promise.reject('raw detail') },
          ],
        }),
        quoteBody,
      );
      expect(res.json()).toEqual({
        error: 'no_route',
        failures: [{ provider: 'odd', error: 'upstream_error' }],
      });
    });

    it('returns internal_error without the message for unexpected errors', async () => {
      const res = await post(
        deps({
          providers: [
            {
              name: 'broken',
              supports: () => {
                throw new Error('secret internal detail');
              },
              quote: async () => Promise.reject(new Error('unreachable')),
            },
          ],
        }),
        quoteBody,
      );
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal_error' });
    });

    it('returns stable codes for malformed and oversized bodies and unknown routes', async () => {
      const app = buildServer(deps());
      const json = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        headers: { 'content-type': 'application/json' },
        payload: '{"sellToken":',
      });
      expect(json.statusCode).toBe(400);
      expect(json.json()).toEqual({ error: 'invalid_request' });
      const big = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ pad: 'x'.repeat(20_000) }),
      });
      expect(big.statusCode).toBe(413);
      expect(big.json()).toEqual({ error: 'payload_too_large' });
      const missing = await app.inject({ method: 'GET', url: '/nope' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'not_found' });
    });
  });

  describe('native wrap and unwrap', () => {
    const failingProvider = {
      name: 'should-not-be-called',
      supports: () => true,
      quote: async (): Promise<ProviderQuote> => {
        throw new Error('provider queried for a wrap');
      },
    };
    const wrapDeps = (overrides: Partial<ServerDeps> = {}): ServerDeps =>
      deps({
        providers: [failingProvider],
        prices: {
          price: async () => {
            throw new Error('oracle queried for a wrap');
          },
        },
        history: {
          hasCompletedSwap: async () => {
            throw new Error('history queried for a wrap');
          },
        },
        signing: SIGNING,
        ...overrides,
      });

    it('answers a wrap with deposit() on WETH, 1:1, free and unsigned', async () => {
      const res = await post(wrapDeps(), { ...quoteBody, buyToken: WETH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        fee: ZERO_FEE,
        direct: {
          kind: 'wrap',
          transaction: {
            to: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            data: '0xd0e30db0',
            value: '1000000000000000000',
          },
          buyAmount: '1000000000000000000',
          minBuyAmount: '1000000000000000000',
        },
      });
    });

    it('answers an unwrap with withdraw(wad) and no value', async () => {
      const res = await post(wrapDeps(), {
        ...quoteBody,
        sellToken: { ...WETH, address: WETH.address.toLowerCase() },
        buyToken: ETH,
      });
      expect(res.statusCode).toBe(200);
      const wad = (10n ** 18n).toString(16).padStart(64, '0');
      expect(res.json()).toEqual({
        fee: ZERO_FEE,
        direct: {
          kind: 'unwrap',
          transaction: {
            to: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            data: `0x2e1a7d4d${wad}`,
            value: '0',
          },
          buyAmount: '1000000000000000000',
          minBuyAmount: '1000000000000000000',
        },
      });
    });

    it('quotes a wrap while the price oracle is down and no providers are configured', async () => {
      const res = await post(wrapDeps({ providers: [] }), { ...quoteBody, buyToken: WETH });
      expect(res.statusCode).toBe(200);
      expect(res.json().direct.kind).toBe('wrap');
    });

    it('still returns the signed fee-wrapper swap for a non-wrap pair', async () => {
      const res = await post(deps({ signing: SIGNING }), {
        ...quoteBody,
        sellToken: TESTNET_ETH,
        buyToken: TESTNET_USDC,
      });
      const body = res.json();
      expect(body.direct).toBeUndefined();
      expect(body.fee.reason).toBe('tier-under-10k');
      expect(body.swap.transaction.to).toBe('0x000000000000000000000000000000000000fee1');
    });

    it('does not treat native to wrapped native on another chain as a wrap', async () => {
      const res = await post(deps({ signing: SIGNING }), { ...quoteBody, buyToken: BASE_WETH });
      // Not a wrap: priced and routed like any swap. Cross-chain routes are refused (fail closed).
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'price_unavailable' });
    });

    it('rejects amounts that do not fit in uint256', async () => {
      const res = await post(wrapDeps(), {
        ...quoteBody,
        buyToken: WETH,
        sellAmount: (2n ** 256n).toString(),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

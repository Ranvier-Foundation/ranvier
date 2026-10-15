import { describe, expect, it } from 'vitest';
import type { FeeQuote, ProviderQuote, QuoteRequest, TokenRef } from '@ranvier/types';
import { padHex, recoverTypedDataAddress } from 'viem';
import { LocalKeySigner } from '../adapters/signers/local-key.js';
import {
  directAnswerEcho,
  QuoteEchoMismatchError,
  signedAnswerEcho,
  signedDeadline,
} from './quote-answer.js';
import type { VettedRoute } from './route-safety.js';
import { buildSignedSwap, sameChainEvmContext, typedData } from './swap-quote.js';

const signer = new LocalKeySigner(padHex('0xa11ce', { size: 32 }), { nodeEnv: 'test' });
const WRAPPER = '0x000000000000000000000000000000000000fee1';
// The same token address on two chains: only the chain tells the answers apart (finding B1).
const SAME_ADDRESS = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const token = (chain: TokenRef['chain'], address = SAME_ADDRESS): TokenRef => ({ chain, address });

const fee: FeeQuote = { bps: 20, reason: 'tier-under-10k', amount: 2_000_000n, waivedUsd: 0n };
// Vetting is covered in route-safety.test.ts; here the route stands in for a vetted one.
const unvetted: ProviderQuote = {
  provider: '0x',
  buyAmount: 4n * 10n ** 17n,
  minBuyAmount: 39n * 10n ** 16n,
  buyAmountUsd: 99_800n,
  gasCostUsd: 5n,
  route: [],
  tx: { to: '0x0000000000001ff3684f28c67538d4d072c22734', data: '0xabcdef', value: 0n },
};
const route = unvetted as VettedRoute;

const requestOn = (chain: TokenRef['chain']): QuoteRequest => ({
  sellToken: token(chain),
  buyToken: token(chain, 'native'),
  sellAmount: 1_000_000_000n,
  taker: '0x00000000000000000000000000000000000000aa',
  slippageBps: 50,
});

const timing = { serverTime: 1_800_000_000, ttlSeconds: 60 };

async function signOn(chain: TokenRef['chain'], t = timing) {
  const request = requestOn(chain);
  const swap = await buildSignedSwap({
    request,
    fee,
    route,
    feeWrapper: WRAPPER,
    signer,
    deadline: signedDeadline(t),
    nonce: 7n,
  });
  return { request, swap };
}

describe('sameChainEvmContext', () => {
  it('returns the request chain keys and the numeric chain ID', () => {
    expect(sameChainEvmContext(requestOn('evm:84532'))).toEqual({
      sellChain: 'evm:84532',
      buyChain: 'evm:84532',
      chainId: 84532,
    });
  });

  it('is undefined for cross-chain and non-EVM requests', () => {
    expect(
      sameChainEvmContext({ sellToken: token('evm:1'), buyToken: token('evm:8453') }),
    ).toBeUndefined();
    expect(
      sameChainEvmContext({
        sellToken: token('solana:mainnet', 'native'),
        buyToken: token('solana:mainnet', 'native'),
      }),
    ).toBeUndefined();
  });
});

describe('signedDeadline', () => {
  it('is serverTime + ttlSeconds', () => {
    expect(signedDeadline({ serverTime: 1_800_000_000, ttlSeconds: 10 })).toBe(1_800_000_010n);
    expect(signedDeadline({ serverTime: 1_800_000_000, ttlSeconds: 600 })).toBe(1_800_000_600n);
  });

  it.each([
    ['serverTime', { serverTime: 0, ttlSeconds: 60 }],
    ['serverTime', { serverTime: 1.5, ttlSeconds: 60 }],
    ['serverTime', { serverTime: Number.MAX_SAFE_INTEGER + 1, ttlSeconds: 60 }],
    ['ttlSeconds', { serverTime: 1_800_000_000, ttlSeconds: 0 }],
    ['ttlSeconds', { serverTime: 1_800_000_000, ttlSeconds: -60 }],
    ['ttlSeconds', { serverTime: 1_800_000_000, ttlSeconds: Number.NaN }],
  ])('refuses a bad %s (%o)', (field, t) => {
    expect(() => signedDeadline(t)).toThrow(new QuoteEchoMismatchError(field));
  });
});

describe('signedAnswerEcho (ADR 0012)', () => {
  // Two testnets a local key may sign for, same token address on both.
  it.each([
    ['evm:84532', 84532],
    ['evm:11155111', 11155111],
  ] as const)('echoes the chain the swap was signed for on %s', async (chain, chainId) => {
    const { request, swap } = await signOn(chain);
    expect(swap.context).toEqual({ sellChain: chain, buyChain: chain, chainId });
    const echo = signedAnswerEcho(request, swap, timing);
    expect(echo).toEqual({
      sellChain: chain,
      buyChain: chain,
      chainId,
      serverTime: 1_800_000_000,
      ttlSeconds: 60,
    });
    expect(swap.quote.deadline).toBe(BigInt(echo.serverTime + echo.ttlSeconds));
    // The echoed chain ID is the EIP-712 domain the signature verifies under, and no other.
    const recover = (id: number) =>
      recoverTypedDataAddress({
        ...typedData(swap.quote, id, WRAPPER),
        signature: swap.signature,
      } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(await recover(echo.chainId)).toBe(signer.address);
    expect(await recover(echo.chainId === 84532 ? 11155111 : 84532)).not.toBe(signer.address);
  });

  it('echoes the configured lifetime at both ends of the allowed range', async () => {
    for (const ttlSeconds of [10, 600]) {
      const t = { serverTime: 1_800_000_123, ttlSeconds };
      const { request, swap } = await signOn('evm:84532', t);
      const echo = signedAnswerEcho(request, swap, t);
      expect(echo.serverTime).toBe(1_800_000_123);
      expect(echo.ttlSeconds).toBe(ttlSeconds);
      expect(swap.quote.deadline).toBe(BigInt(1_800_000_123 + ttlSeconds));
    }
  });

  describe('cannot disagree with what was signed', () => {
    it('refuses a context for another chain than the request', async () => {
      const { swap } = await signOn('evm:84532');
      expect(() => signedAnswerEcho(requestOn('evm:11155111'), swap, timing)).toThrow(
        new QuoteEchoMismatchError('chain'),
      );
    });

    it.each([
      ['chainId', { chainId: 11155111 }],
      ['sellChain', { sellChain: 'evm:11155111' as const }],
      ['buyChain', { buyChain: 'evm:11155111' as const }],
    ])('refuses a tampered context %s', async (_field, change) => {
      const { request, swap } = await signOn('evm:84532');
      const tampered = { ...swap, context: { ...swap.context, ...change } };
      expect(() => signedAnswerEcho(request, tampered, timing)).toThrow(
        new QuoteEchoMismatchError('chain'),
      );
    });

    it('refuses a cross-chain request', async () => {
      const { swap } = await signOn('evm:84532');
      const crossChain = { sellToken: token('evm:84532'), buyToken: token('evm:11155111') };
      expect(() => signedAnswerEcho(crossChain, swap, timing)).toThrow(
        new QuoteEchoMismatchError('chain'),
      );
    });

    it.each([
      ['a later serverTime', { serverTime: 1_800_000_001, ttlSeconds: 60 }],
      ['an earlier serverTime', { serverTime: 1_799_999_999, ttlSeconds: 60 }],
      ['a longer lifetime', { serverTime: 1_800_000_000, ttlSeconds: 61 }],
      ['a shorter lifetime', { serverTime: 1_800_000_000, ttlSeconds: 59 }],
    ])('refuses timing with %s than the signed deadline', async (_name, other) => {
      const { request, swap } = await signOn('evm:84532');
      expect(() => signedAnswerEcho(request, swap, other)).toThrow(
        new QuoteEchoMismatchError('deadline'),
      );
    });
  });
});

describe('directAnswerEcho (ADR 0012)', () => {
  it.each([
    ['evm:1', 1],
    ['evm:8453', 8453],
  ] as const)('echoes the request chain on %s', (chain, chainId) => {
    expect(directAnswerEcho(requestOn(chain))).toEqual({
      sellChain: chain,
      buyChain: chain,
      chainId,
    });
  });

  it('refuses cross-chain and non-EVM requests', () => {
    expect(() =>
      directAnswerEcho({ sellToken: token('evm:1'), buyToken: token('evm:8453') }),
    ).toThrow(QuoteEchoMismatchError);
    expect(() =>
      directAnswerEcho({
        sellToken: token('solana:mainnet', 'native'),
        buyToken: token('solana:mainnet', 'native'),
      }),
    ).toThrow(QuoteEchoMismatchError);
  });
});

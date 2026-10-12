import { describe, expect, it } from 'vitest';
import type { FeeQuote, ProviderQuote, QuoteRequest } from '@ranvier/types';
import { decodeFunctionData, keccak256, padHex, recoverTypedDataAddress, zeroAddress } from 'viem';
import {
  assertLocalSigningChains,
  LocalKeySigner,
  NEVER_LOCAL_CHAINS,
} from '../adapters/signers/local-key.js';
import type { VettedRoute } from './route-safety.js';
import {
  buildSignedSwap,
  FEE_WRAPPER_ABI,
  quoteDigest,
  typedData,
  type SwapQuote,
} from './swap-quote.js';

/** Golden values shared with contracts/test/QuoteSigningCompat.t.sol. */
const GOLDEN = {
  wrapper: '0x000000000000000000000000000000000000fee1',
  signer: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7',
  digest: '0xc5c18c006aa73b004031c786d634987179d5325425f6632c4350925c89a0e276',
  signature:
    '0xe2b5fbde8e1861cd293e88340c35d39d0b498d7336cf651f504df0c242c99cd83f0cc31e6cb7edc8b3a86f47475b9f9ad441a104a51baba96992e80d5e47c1d81b',
} as const;

const goldenQuote: SwapQuote = {
  user: '0x00000000000000000000000000000000000000aa',
  tokenIn: '0x00000000000000000000000000000000000000b1',
  tokenOut: '0x00000000000000000000000000000000000000c2',
  amountIn: 1_000_000_000n,
  minAmountOut: 10n ** 18n,
  feeAmount: 1_234_567n,
  router: '0x0000000000001fF3684f28c67538d4D072C22734',
  routerCalldataHash: keccak256('0x1234'),
  nonce: 42n,
  deadline: 1_800_000_000n,
};

const signer = new LocalKeySigner(padHex('0xa11ce', { size: 32 }), { nodeEnv: 'test' });

describe('EIP-712 compatibility with FeeWrapper.sol', () => {
  it('produces the digest the contract computes', () => {
    expect(quoteDigest(goldenQuote, 31337, GOLDEN.wrapper)).toBe(GOLDEN.digest);
  });

  it('produces the signature the contract accepts', async () => {
    expect(signer.address).toBe(GOLDEN.signer);
    expect(await signer.signTypedData(typedData(goldenQuote, 31337, GOLDEN.wrapper))).toBe(
      GOLDEN.signature,
    );
  });

  it('binds the signature to the chain', () => {
    expect(quoteDigest(goldenQuote, 8453, GOLDEN.wrapper)).not.toBe(GOLDEN.digest);
  });
});

describe('buildSignedSwap', () => {
  // Base Sepolia: a local key may sign for testnets only.
  const USDC = {
    chain: 'evm:84532' as const,
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    decimals: 6,
  };
  const WETH = {
    chain: 'evm:84532' as const,
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    decimals: 18,
  };
  const ETH = { chain: 'evm:84532' as const, address: 'native' };
  const request: QuoteRequest = {
    sellToken: USDC,
    buyToken: WETH,
    sellAmount: 1_000_000_000n,
    taker: '0x00000000000000000000000000000000000000AA',
    slippageBps: 50,
  };
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
  const base = {
    request,
    fee,
    route,
    feeWrapper: GOLDEN.wrapper,
    signer,
    deadline: 1_800_000_060n,
    nonce: 7n,
  } as const;

  it('signs the gross input, exact fee and route minimum', async () => {
    const swap = await buildSignedSwap(base);
    expect(swap.quote).toEqual({
      user: '0x00000000000000000000000000000000000000AA',
      tokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      tokenOut: '0x4200000000000000000000000000000000000006',
      amountIn: 1_000_000_000n,
      minAmountOut: 39n * 10n ** 16n,
      feeAmount: 2_000_000n,
      router: '0x0000000000001fF3684f28c67538d4D072C22734',
      routerCalldataHash: keccak256('0xabcdef'),
      nonce: 7n,
      deadline: 1_800_000_060n,
    });
    const recovered = await recoverTypedDataAddress({
      ...typedData(swap.quote, 84532, GOLDEN.wrapper),
      signature: swap.signature,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered).toBe(signer.address);
  });

  it('encodes a call to the fee wrapper', async () => {
    const swap = await buildSignedSwap(base);
    expect(swap.transaction.to).toBe(GOLDEN.wrapper);
    expect(swap.transaction.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: FEE_WRAPPER_ABI, data: swap.transaction.data });
    expect(decoded.functionName).toBe('swap');
    expect(decoded.args).toEqual([swap.quote, swap.signature, '0xabcdef']);
  });

  it('sends the gross amount as value for native input', async () => {
    const swap = await buildSignedSwap({ ...base, request: { ...request, sellToken: ETH } });
    expect(swap.quote.tokenIn).toBe(zeroAddress);
    expect(swap.transaction.value).toBe(1_000_000_000n);
  });

  it('refuses cross-chain and non-EVM requests', async () => {
    await expect(
      buildSignedSwap({ ...base, request: { ...request, buyToken: { ...WETH, chain: 'evm:1' } } }),
    ).rejects.toThrow();
    await expect(
      buildSignedSwap({
        ...base,
        request: {
          ...request,
          sellToken: { ...USDC, chain: 'evm:8453' },
          buyToken: { ...WETH, chain: 'evm:8453' },
        },
      }),
    ).rejects.toThrow('signer refuses chain 8453');
    await expect(
      buildSignedSwap({
        ...base,
        request: { ...request, sellToken: { ...USDC, chain: 'evm:1' } },
      }),
    ).rejects.toThrow();
    await expect(
      buildSignedSwap({
        ...base,
        request: { ...request, sellToken: { ...USDC, chain: 'solana:mainnet' } },
      }),
    ).rejects.toThrow();
  });
});

describe('LocalKeySigner', () => {
  const key = padHex('0x1', { size: 32 });
  const typed = (chainId: number | undefined) => ({
    ...typedData(goldenQuote, chainId ?? 1, GOLDEN.wrapper),
    domain: { ...typedData(goldenQuote, 1, GOLDEN.wrapper).domain, chainId },
  });

  it('refuses to run in production', () => {
    expect(() => new LocalKeySigner(key, { nodeEnv: 'production' })).toThrow('KMS');
  });

  it('reads NODE_ENV when not given explicitly', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new LocalKeySigner(key)).toThrow('KMS');
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it('signs for testnets and local chains by default', () => {
    const s = new LocalKeySigner(key, { nodeEnv: 'test' });
    for (const id of [84532, 11155111, 421614, 31337]) expect(s.canSign(id)).toBe(true);
  });

  it('never signs for a mainnet, whatever the configuration', async () => {
    const s = new LocalKeySigner(key, { nodeEnv: 'test' });
    for (const id of [1, 10, 56, 137, 8453, 42161, 43114]) {
      expect(NEVER_LOCAL_CHAINS.has(id)).toBe(true);
      expect(s.canSign(id)).toBe(false);
      await expect(s.signTypedData(typed(id))).rejects.toThrow(`refuses chain ${id}`);
    }
    expect(() => new LocalKeySigner(key, { nodeEnv: 'test', allowedChainIds: [31337, 1] })).toThrow(
      'mainnet chain(s) 1',
    );
  });

  it('refuses chains outside its allowlist and typed data without a chain', async () => {
    const s = new LocalKeySigner(key, { nodeEnv: 'test', allowedChainIds: [31337] });
    expect(s.canSign(84532)).toBe(false);
    await expect(s.signTypedData(typed(84532))).rejects.toThrow('refuses chain 84532');
    await expect(s.signTypedData(typed(undefined))).rejects.toThrow('refuses chain undefined');
    await expect(s.signTypedData(typed(31337))).resolves.toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('fails startup when configured signing chains include a refused chain', () => {
    const s = new LocalKeySigner(key, { nodeEnv: 'test' });
    expect(() => assertLocalSigningChains([84532, 31337], s)).not.toThrow();
    expect(() => assertLocalSigningChains([1, 8453, 42161], s)).toThrow(
      'ZEROX_CHAIN_IDS includes chain(s) 1, 8453, 42161',
    );
  });
});

import { NATIVE } from '@ranvier/chains';
import type { FeeQuote, QuoteChainEcho, QuoteRequest, TokenRef } from '@ranvier/types';
import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  zeroAddress,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import type { QuoteSigner } from '../ports/quote-signer.js';
import type { VettedRoute } from './route-safety.js';

/** Must match FeeWrapper's EIP712("Ranvier FeeWrapper", "1") and SWAP_QUOTE_TYPEHASH. */
export const EIP712_NAME = 'Ranvier FeeWrapper';
export const EIP712_VERSION = '1';

export const SWAP_QUOTE_TYPES = {
  SwapQuote: [
    { name: 'user', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'feeAmount', type: 'uint256' },
    { name: 'router', type: 'address' },
    { name: 'routerCalldataHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

const SWAP_QUOTE_TUPLE = {
  type: 'tuple',
  components: SWAP_QUOTE_TYPES.SwapQuote,
} as const;

export const FEE_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      { name: 'q', ...SWAP_QUOTE_TUPLE },
      { name: 'signature', type: 'bytes' },
      { name: 'routerCalldata', type: 'bytes' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface SwapQuote {
  user: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
  minAmountOut: bigint;
  feeAmount: bigint;
  router: Hex;
  routerCalldataHash: Hex;
  nonce: bigint;
  deadline: bigint;
}

export interface SignedSwap {
  quote: SwapQuote;
  signature: Hex;
  /** Transaction the user signs: a call to the fee wrapper. */
  transaction: { to: Hex; data: Hex; value: bigint };
  /**
   * The chain this swap was signed for: the very value passed to the EIP-712 domain. Not part
   * of the signed struct; the HTTP layer echoes it at the top of the answer (ADR 0012).
   */
  context: QuoteChainContext;
}

export function typedData(quote: SwapQuote, chainId: number, feeWrapper: Hex): TypedDataDefinition {
  return {
    domain: {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      chainId,
      verifyingContract: toAddress(feeWrapper),
    },
    types: SWAP_QUOTE_TYPES,
    primaryType: 'SwapQuote',
    message: { ...quote },
  };
}

export function quoteDigest(quote: SwapQuote, chainId: number, feeWrapper: Hex): Hex {
  return hashTypedData(typedData(quote, chainId, feeWrapper));
}

/** Accepts any letter case; checksums are for display, not validation, at this layer. */
export function toAddress(value: string): Hex {
  return getAddress(value.toLowerCase());
}

function contractToken(token: TokenRef): Hex {
  return token.address === NATIVE ? zeroAddress : toAddress(token.address);
}

export function evmChainId(token: TokenRef): number | undefined {
  const match = /^evm:(\d+)$/.exec(token.chain);
  return match ? Number(match[1]) : undefined;
}

/**
 * The chain a same-chain EVM quote is built for (ADR 0012): the request's own chain keys and
 * the numeric chain ID derived from them. For a signed swap `chainId` is the EIP-712 domain
 * chain ID; for a direct wrap it is the chain of the plain transaction.
 */
export type QuoteChainContext = QuoteChainEcho;

/** The context of a same-chain EVM request, or undefined for cross-chain and non-EVM requests. */
export function sameChainEvmContext(
  request: Pick<QuoteRequest, 'sellToken' | 'buyToken'>,
): QuoteChainContext | undefined {
  const chainId = evmChainId(request.sellToken);
  if (chainId === undefined || request.buyToken.chain !== request.sellToken.chain) {
    return undefined;
  }
  return { sellChain: request.sellToken.chain, buyChain: request.buyToken.chain, chainId };
}

export interface BuildSwapInput {
  request: QuoteRequest;
  fee: FeeQuote;
  /** Only a route that passed `vetRoute` can be signed. */
  route: VettedRoute;
  feeWrapper: Hex;
  signer: QuoteSigner;
  /** Unix seconds. */
  deadline: bigint;
  /** Random 256-bit value; the wrapper rejects reused nonces per user. */
  nonce: bigint;
}

/**
 * Builds the signed fee-wrapper call for the chosen route. The router calldata was quoted
 * for `amountIn - feeAmount`, which is exactly what the wrapper forwards, and `vetRoute` has
 * checked it (ADR 0004). `minAmountOut` is the vetted floor, at least the user's slippage.
 */
export async function buildSignedSwap(input: BuildSwapInput): Promise<SignedSwap> {
  const { request, fee, route, feeWrapper, signer, deadline, nonce } = input;
  const context = sameChainEvmContext(request);
  if (!context) throw new Error('signed swaps are same-chain EVM only');
  const { chainId } = context;
  if (!signer.canSign(chainId)) throw new Error(`signer refuses chain ${chainId}`);

  const routerCalldata = route.tx.data as Hex;
  const quote: SwapQuote = {
    user: toAddress(request.taker),
    tokenIn: contractToken(request.sellToken),
    tokenOut: contractToken(request.buyToken),
    amountIn: request.sellAmount,
    minAmountOut: route.minBuyAmount,
    feeAmount: fee.amount,
    router: toAddress(route.tx.to),
    routerCalldataHash: keccak256(routerCalldata),
    nonce,
    deadline,
  };
  const signature = await signer.signTypedData(typedData(quote, chainId, feeWrapper));
  const data = encodeFunctionData({
    abi: FEE_WRAPPER_ABI,
    functionName: 'swap',
    args: [quote, signature, routerCalldata],
  });
  const value = quote.tokenIn === zeroAddress ? quote.amountIn : 0n;
  return { quote, signature, transaction: { to: feeWrapper, data, value }, context };
}

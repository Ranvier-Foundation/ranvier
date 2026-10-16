import { NATIVE } from '@ranvier/chains';
import { isWrapOrUnwrap } from '@ranvier/fees';
import type { QuoteRequest } from '@ranvier/types';
import { encodeFunctionData, maxUint256, type Hex } from 'viem';
import { REGISTRY_CATALOG, type ChainCatalog } from '../chain-catalog.js';
import { evmChainId, toAddress } from './swap-quote.js';

/** The two WETH9 functions a native wrap/unwrap needs. */
export const WRAPPED_NATIVE_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

/**
 * A wrap or unwrap answered without a provider, the fee wrapper or a signature
 * (ADR 0003). Output is exactly 1:1 with the input.
 */
export interface DirectWrap {
  kind: 'wrap' | 'unwrap';
  /** Plain call to the chain's wrapped native contract. */
  transaction: { to: Hex; data: Hex; value: bigint };
  buyAmount: bigint;
  minBuyAmount: bigint;
}

/**
 * Returns the direct wrap/unwrap transaction when the request is native <-> the same EVM
 * chain's wrapped native token (per the fee schedule's own detection), otherwise undefined.
 * Solana wSOL is out of scope and returns undefined.
 *
 * The fee schedule decides first, from the registry: a chain outside the registry (a catalog's
 * extra chain) is never a wrap, whatever the catalog says.
 */
export function buildDirectWrap(
  request: Pick<QuoteRequest, 'sellToken' | 'buyToken' | 'sellAmount'>,
  catalog: ChainCatalog = REGISTRY_CATALOG,
): DirectWrap | undefined {
  const { sellToken, buyToken, sellAmount } = request;
  if (evmChainId(sellToken) === undefined) return undefined;
  if (!isWrapOrUnwrap(sellToken, buyToken)) return undefined;
  const chain = catalog.getChain(sellToken.chain);
  if (!chain) return undefined;
  if (sellAmount <= 0n || sellAmount > maxUint256) {
    throw new RangeError('sellAmount must be between 1 and 2^256 - 1');
  }

  const to = toAddress(chain.wrappedNative);
  const transaction =
    sellToken.address === NATIVE
      ? {
          to,
          data: encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: 'deposit' }),
          value: sellAmount,
        }
      : {
          to,
          data: encodeFunctionData({
            abi: WRAPPED_NATIVE_ABI,
            functionName: 'withdraw',
            args: [sellAmount],
          }),
          value: 0n,
        };
  return {
    kind: sellToken.address === NATIVE ? 'wrap' : 'unwrap',
    transaction,
    buyAmount: sellAmount,
    minBuyAmount: sellAmount,
  };
}

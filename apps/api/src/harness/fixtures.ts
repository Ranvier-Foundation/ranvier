/**
 * LOCAL TEST HARNESS ONLY (ADR 0013, section 3).
 * Lives in `src/harness/`: excluded from the build (`dist/`), never imported by production code.
 *
 * Harness stand-ins for the two inputs the API takes from outside: a quote provider that answers
 * the way 0x does (AllowanceHolder `exec` wrapping a Settler `execute`, the shape `vetRoute` checks)
 * for the MockSettler pairs, and a fixed-price oracle for the harness tokens. Both refuse every
 * chain but 31337. The rates are the ones `DeployHarness.pairTable` deploys, from ETH and hWETH at
 * $3,000 and every other harness token at $1.
 */
import { NATIVE } from '@ranvier/chains';
import type { ProviderQuote, QuoteRequest, TokenRef } from '@ranvier/types';
import { encodeFunctionData, zeroAddress, type Hex } from 'viem';
import { ALLOWANCE_HOLDER_ABI, SETTLER_ABI, ZEROX_NATIVE_OUT } from '../domain/allowance-holder.js';
import { slippageFloor } from '../domain/route-safety.js';
import type { PriceOracle, TokenPrice } from '../ports/price-oracle.js';
import type { QuoteProvider } from '../ports/quote-provider.js';
import { ETH_USD, HARNESS_CHAIN_KEY, HARNESS_NATIVE, PINNED, pinnedDecimals } from './pinned.js';

const lower = (a: string): string => a.toLowerCase();

const USDC_PER_ETH = ETH_USD * 10n ** 6n; // hUSDC base units per 1e18 wei
const WEI = 10n ** 18n;

/** Rate of one MockSettler pair: `out = in * num / den` (DeployHarness.pairTable). */
interface Rate {
  num: bigint;
  den: bigint;
}

/** Pairs keyed `${sell}>${buy}` with request spellings (`native` or lowercase address). */
const RATES: ReadonlyMap<string, Rate> = new Map([
  [`${NATIVE}>${lower(PINNED.hUSDC)}`, { num: USDC_PER_ETH, den: WEI }],
  [`${lower(PINNED.hUSDC)}>${NATIVE}`, { num: WEI, den: USDC_PER_ETH }],
  [`${lower(PINNED.hUSDC)}>${lower(PINNED.hWETH)}`, { num: WEI, den: USDC_PER_ETH }],
  [`${lower(PINNED.hWETH)}>${lower(PINNED.hUSDC)}`, { num: USDC_PER_ETH, den: WEI }],
  // (a) The market rate is 1:1; the mock router then pays `minAmountOut - 1`.
  [`${lower(PINNED.hUSDC)}>${lower(PINNED.hUNDER)}`, { num: 1n, den: 1n }],
  // The router really pays 90% of the fair rate, and the quote says so.
  [`${lower(PINNED.hUSDC)}>${lower(PINNED.hORACLE)}`, { num: 9n, den: 10n }],
]);

export interface ZeroXArgs {
  operator: Hex;
  /** AllowanceHolder `token`: the zero address for native input, as 0x encodes it. */
  token: Hex;
  amount: bigint;
  target: Hex;
  recipient: Hex;
  /** Settler `buyToken`: 0xeeee...eeee for native output, as 0x encodes it. */
  buyToken: Hex;
  minAmountOut: bigint;
}

/** AllowanceHolder `exec(operator, token, amount, target, Settler.execute(...))`, as 0x sends it. */
export function zeroXCalldata(a: ZeroXArgs): Hex {
  const inner = encodeFunctionData({
    abi: SETTLER_ABI,
    functionName: 'execute',
    args: [
      { recipient: a.recipient, buyToken: a.buyToken, minAmountOut: a.minAmountOut },
      [],
      `0x${'00'.repeat(32)}`,
    ],
  });
  return encodeFunctionData({
    abi: ALLOWANCE_HOLDER_ABI,
    functionName: 'exec',
    args: [a.operator, a.token, a.amount, a.target, inner],
  });
}

function onHarnessChain(req: Pick<QuoteRequest, 'sellToken' | 'buyToken'>): boolean {
  return req.sellToken.chain === HARNESS_CHAIN_KEY && req.buyToken.chain === HARNESS_CHAIN_KEY;
}

/**
 * Answers like the 0x provider for the MockSettler pairs on chain 31337 only: the router is the
 * mock AllowanceHolder, operator and target the MockSettler, the input token the zero address for
 * native, the recipient the taker, and `minBuyAmount = slippageFloor(buyAmount, slippageBps)`.
 */
export class HarnessQuoteProvider implements QuoteProvider {
  readonly name = 'harness-0x';

  supports(req: QuoteRequest): boolean {
    return onHarnessChain(req) && RATES.has(`${req.sellToken.address}>${req.buyToken.address}`);
  }

  quote(req: QuoteRequest, signal: AbortSignal): Promise<ProviderQuote> {
    signal.throwIfAborted();
    const rate = RATES.get(`${req.sellToken.address}>${req.buyToken.address}`);
    if (!onHarnessChain(req) || !rate) {
      return Promise.reject(new Error('harness provider: pair not quoted'));
    }
    const nativeIn = req.sellToken.address === NATIVE;
    const nativeOut = req.buyToken.address === NATIVE;
    const buyAmount = (req.sellAmount * rate.num) / rate.den;
    const minBuyAmount = slippageFloor(buyAmount, req.slippageBps);
    const data = zeroXCalldata({
      operator: PINNED.settler,
      token: nativeIn ? zeroAddress : (req.sellToken.address as Hex),
      amount: req.sellAmount,
      target: PINNED.settler,
      recipient: req.taker as Hex,
      buyToken: nativeOut ? ZEROX_NATIVE_OUT : (req.buyToken.address as Hex),
      minAmountOut: minBuyAmount,
    });
    return Promise.resolve({
      provider: this.name,
      buyAmount,
      minBuyAmount,
      buyAmountUsd: 0n,
      gasCostUsd: 0n,
      route: [],
      tx: { to: lower(PINNED.allowanceHolder), data, value: nativeIn ? req.sellAmount : 0n },
    });
  }
}

const E18 = 10n ** 18n;

const PRICES: ReadonlyMap<string, TokenPrice> = new Map([
  [NATIVE, { decimals: HARNESS_NATIVE.decimals, usdE18: ETH_USD * E18 }],
  [lower(PINNED.hWETH), { decimals: pinnedDecimals('hWETH'), usdE18: ETH_USD * E18 }],
  [lower(PINNED.hUSDC), { decimals: pinnedDecimals('hUSDC'), usdE18: E18 }],
  [lower(PINNED.hUNDER), { decimals: 6, usdE18: E18 }],
  [lower(PINNED.hORACLE), { decimals: 6, usdE18: E18 }],
]);

/** Fixed prices for the harness tokens on chain 31337; throws for anything else (fail closed). */
export class FixedPriceOracle implements PriceOracle {
  price(token: TokenRef, signal: AbortSignal): Promise<TokenPrice> {
    signal.throwIfAborted();
    const price = token.chain === HARNESS_CHAIN_KEY ? PRICES.get(token.address) : undefined;
    if (!price) return Promise.reject(new Error('harness oracle: no price for this token'));
    return Promise.resolve(price);
  }
}

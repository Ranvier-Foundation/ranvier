import { getChain, NATIVE } from '@ranvier/chains';
import type { ProviderQuote, QuoteRequest, Token } from '@ranvier/types';
import { z } from 'zod';
import type { PriceOracle } from '../../ports/price-oracle.js';
import type { QuoteProvider } from '../../ports/quote-provider.js';

/** 0x represents the native token with this sentinel address. */
const ZEROX_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * 0x AllowanceHolder on Cancun-enabled chains. The fee wrapper approves and calls this
 * contract, so it must also be on the wrapper's on-chain router allowlist.
 */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';

const uint = z.string().regex(/^\d+$/).transform(BigInt);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const quoteSchema = z.discriminatedUnion('liquidityAvailable', [
  z.object({ liquidityAvailable: z.literal(false) }),
  z.object({
    liquidityAvailable: z.literal(true),
    buyAmount: uint,
    minBuyAmount: uint,
    totalNetworkFee: uint.nullable(),
    route: z.object({
      fills: z.array(
        z.object({
          from: address,
          to: address,
          source: z.string(),
          proportionBps: z.coerce.number(),
        }),
      ),
    }),
    transaction: z.object({
      to: address,
      data: z.string().regex(/^0x[0-9a-fA-F]*$/),
      value: uint,
    }),
  }),
]);

export class NoLiquidityError extends Error {}
export class UnexpectedRouterError extends Error {}

export interface ZeroXOptions {
  apiKey: string;
  /** Fee wrapper address: the taker that holds the input when 0x's calldata runs. */
  feeWrapper: string;
  /** EVM chain IDs where both 0x and the fee wrapper are live. */
  chainIds: readonly number[];
  prices: PriceOracle;
  /** Contracts the returned transaction may target. */
  allowedRouters?: readonly string[];
  baseUrl?: string;
  fetch?: typeof fetch;
}

function chainIdOf(token: Token): number | undefined {
  const match = /^evm:(\d+)$/.exec(token.chain);
  return match ? Number(match[1]) : undefined;
}

function toZeroXToken(token: Token): string {
  return token.address === NATIVE ? ZEROX_NATIVE : token.address;
}

/**
 * Same-chain EVM quotes from the 0x Swap API (v2, AllowanceHolder).
 * Quotes are built for the fee wrapper as taker, with output paid straight to the user.
 */
export class ZeroXProvider implements QuoteProvider {
  readonly name = '0x';
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly allowedRouters: ReadonlySet<string>;

  constructor(private readonly opts: ZeroXOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.0x.org';
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.allowedRouters = new Set(
      (opts.allowedRouters ?? [ZEROX_ALLOWANCE_HOLDER]).map((a) => a.toLowerCase()),
    );
  }

  supports(req: QuoteRequest): boolean {
    const chainId = chainIdOf(req.sellToken);
    return (
      chainId !== undefined &&
      req.buyToken.chain === req.sellToken.chain &&
      this.opts.chainIds.includes(chainId)
    );
  }

  async quote(req: QuoteRequest, signal: AbortSignal): Promise<ProviderQuote> {
    const params = new URLSearchParams({
      chainId: String(chainIdOf(req.sellToken)),
      sellToken: toZeroXToken(req.sellToken),
      buyToken: toZeroXToken(req.buyToken),
      sellAmount: req.sellAmount.toString(),
      taker: this.opts.feeWrapper,
      recipient: req.taker,
      txOrigin: req.taker,
      slippageBps: String(req.slippageBps),
    });
    const res = await this.fetch(`${this.baseUrl}/swap/allowance-holder/quote?${params}`, {
      headers: { '0x-api-key': this.opts.apiKey, '0x-version': 'v2' },
      signal,
    });
    if (!res.ok) throw new Error(`0x returned ${res.status}`);

    const body = quoteSchema.parse(await res.json());
    if (!body.liquidityAvailable) throw new NoLiquidityError('no liquidity');
    if (!this.allowedRouters.has(body.transaction.to.toLowerCase())) {
      throw new UnexpectedRouterError(`unexpected router ${body.transaction.to}`);
    }

    const chain = getChain(req.sellToken.chain);
    const native: Token = {
      chain: req.sellToken.chain,
      address: NATIVE,
      symbol: chain?.nativeSymbol ?? 'ETH',
      decimals: 18,
    };
    const [buyAmountUsd, gasCostUsd] = await Promise.all([
      this.opts.prices.usdValue(req.buyToken, body.buyAmount, signal),
      this.opts.prices.usdValue(native, body.totalNetworkFee ?? 0n, signal),
    ]);

    return {
      provider: this.name,
      buyAmount: body.buyAmount,
      minBuyAmount: body.minBuyAmount,
      buyAmountUsd,
      gasCostUsd,
      route: body.route.fills.map((f) => ({
        protocol: f.source,
        from: f.from,
        to: f.to,
        proportionBps: f.proportionBps,
      })),
      tx: { to: body.transaction.to, data: body.transaction.data, value: body.transaction.value },
    };
  }
}

import { NATIVE } from '@ranvier/chains';
import type { ProviderQuote, QuoteRequest, TokenRef } from '@ranvier/types';
import { z } from 'zod';
import { usdCents } from '../../domain/usd.js';
import type { PriceOracle } from '../../ports/price-oracle.js';
import { ProviderError } from '../../ports/provider-error.js';
import type { QuoteProvider } from '../../ports/quote-provider.js';
import { ZEROX_ALLOWANCE_HOLDER } from '../../trusted-routers.js';

export { ZEROX_ALLOWANCE_HOLDER };

/** 0x represents the native token with this sentinel address in API parameters. */
const ZEROX_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

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

function chainIdOf(token: TokenRef): number | undefined {
  const match = /^evm:(\d+)$/.exec(token.chain);
  return match ? Number(match[1]) : undefined;
}

function toZeroXToken(token: TokenRef): string {
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
    const native: TokenRef = { chain: req.sellToken.chain, address: NATIVE };
    // Start pricing now so it overlaps the quote request instead of following it.
    const pricing = Promise.all([
      this.opts.prices.price(req.buyToken, signal),
      this.opts.prices.price(native, signal),
    ]);
    // Settled later; this only stops an early rejection being reported as unhandled.
    pricing.catch(() => undefined);

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
    if (!res.ok) throw new ProviderError('upstream_error', `0x returned ${res.status}`);

    const parsed = quoteSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new ProviderError('invalid_response', '0x response failed schema');
    const body = parsed.data;
    if (!body.liquidityAvailable) throw new ProviderError('no_liquidity', 'no liquidity');
    if (!this.allowedRouters.has(body.transaction.to.toLowerCase())) {
      throw new ProviderError('invalid_response', `unexpected router ${body.transaction.to}`);
    }

    const [buyPrice, nativePrice] = await pricing;
    return {
      provider: this.name,
      buyAmount: body.buyAmount,
      minBuyAmount: body.minBuyAmount,
      buyAmountUsd: usdCents(buyPrice, body.buyAmount),
      gasCostUsd: usdCents(nativePrice, body.totalNetworkFee ?? 0n),
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

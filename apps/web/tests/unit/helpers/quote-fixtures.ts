import type { QuoteAsk } from '../../../src/lib/api/quote';

export const TAKER = '0x7a3E1b2C9d4F5a60718293a4B5c6D7e8F9013F9c';
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const ZERO = '0x0000000000000000000000000000000000000000';

/** 0.05 ETH to USDC on Ethereum. */
export const ASK: QuoteAsk = {
  sellToken: { chain: 'evm:1', address: 'native' },
  buyToken: { chain: 'evm:1', address: USDC },
  sellAmount: 50_000_000_000_000_000n,
  taker: TAKER,
  slippageBps: 50,
};

type Json = Record<string, unknown>;

/** What the secret parts of an answer look like: none of these strings may ever be kept. */
export const SECRETS = [
  'ROUTERCALLDATA',
  'SIGNEDSWAPCALLDATA',
  'SIGNATUREDONOTKEEP',
  'SECRETCALLDATAHASH',
  'FEEWRAPPERADDRESS',
  '0x0000000000001ff3684f28c67538d4d072c22734',
  '123456789',
  'Uniswap_V3',
];

/** A routed answer shaped like `POST /v1/quotes` (apps/api/src/http/server.ts) for `ASK`. */
export function swapAnswer(over: { fee?: Json; best?: Json; quote?: Json; top?: Json } = {}): Json {
  const best = {
    provider: '0x',
    buyAmount: '124750000',
    minBuyAmount: '124126250',
    gasCostUsd: '31',
    buyAmountUsd: '12475',
    route: [{ protocol: 'Uniswap_V3', from: 'native', to: USDC, proportionBps: 10000 }],
    tx: { to: '0x0000000000001ff3684f28c67538d4d072c22734', data: '0xROUTERCALLDATA', value: '0' },
    ...over.best,
  };
  return {
    fee: { bps: 20, reason: 'tier-under-10k', amount: '100000000000000', waivedUsd: '0', ...over.fee },
    best,
    quotes: [best, best],
    failures: [{ provider: '1inch', error: 'timeout' }],
    swap: {
      quote: {
        user: TAKER.toLowerCase(),
        tokenIn: ZERO,
        tokenOut: USDC,
        amountIn: '50000000000000000',
        minAmountOut: '124126250',
        feeAmount: '100000000000000',
        router: '0x0000000000001ff3684f28c67538d4d072c22734',
        routerCalldataHash: '0xSECRETCALLDATAHASH',
        nonce: '123456789',
        deadline: '1790000060',
        ...over.quote,
      },
      signature: '0xSIGNATUREDONOTKEEP',
      transaction: { to: '0xFEEWRAPPERADDRESS', data: '0xSIGNEDSWAPCALLDATA', value: '50000000000000000' },
    },
    ...over.top,
  };
}

/** A direct wrap answer (ETH to WETH) for `WRAP_ASK`. */
export const WRAP_ASK: QuoteAsk = {
  ...ASK,
  buyToken: { chain: 'evm:1', address: WETH },
};

export function wrapAnswer(over: { direct?: Json; fee?: Json } = {}): Json {
  return {
    fee: { bps: 0, reason: 'wrap-unwrap', amount: '0', waivedUsd: '0', ...over.fee },
    direct: {
      kind: 'wrap',
      transaction: { to: WETH, data: '0xd0e30db0', value: '50000000000000000' },
      buyAmount: '50000000000000000',
      minBuyAmount: '50000000000000000',
      ...over.direct,
    },
  };
}

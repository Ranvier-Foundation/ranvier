'use client';

import { useCallback, useMemo, useState } from 'react';
import { useConnection } from 'wagmi';
import type { ChainKey, TokenRef } from '@ranvier/types';
import type { ChainBalances } from '@/lib/picker/model';
import { useBalances } from '@/lib/picker/use-balances';
import { useChains, type ChainsState } from '@/lib/picker/use-chains';
import {
  cleanAmountText,
  fitToDecimals,
  formatUnitsExact,
  parseAmount,
  type AmountParse,
} from './amount';
import { ctaState, pairSupport, quoteAsk, type CtaState, type PairSupport } from './model';
import { defaultSwapTokens, resolveToken, sameToken, type SwapToken } from './tokens';
import { useQuote, type QuoteState } from './use-quote';

export type Side = 'pay' | 'receive';

export interface SwapForm {
  /** The connected wallet, or `undefined` (also while it is connecting). */
  taker: string | undefined;
  pay: SwapToken | null;
  receive: SwapToken | null;
  amountText: string;
  amount: AmountParse;
  chains: ChainsState;
  pair: PairSupport | undefined;
  quote: QuoteState;
  cta: CtaState;
  /** The last balance read of the pay token, when there is one. Display only (ADR 0011). */
  payBalance: bigint | undefined;
  /** The balance read of the pay chain failed or is not available. */
  balances: ReadonlyMap<ChainKey, ChainBalances>;
  /** A token the picker returned that this build does not list. */
  unknownToken: boolean;
  setAmount: (raw: string) => void;
  select: (side: Side, ref: TokenRef) => void;
  flip: () => void;
  refreshQuote: () => void;
  refreshBalance: () => void;
}

/**
 * State of the swap screen: the two tokens, the typed amount (text, converted to bigint base units
 * with the pay token's decimals by exact string maths), the quote and the button's state. Balances
 * are read for the pay chain and only ever shown: nothing here asks or declines to ask for a quote
 * because of one.
 */
export function useSwap(): SwapForm {
  const { status, address } = useConnection();
  const taker = status === 'connected' ? address : undefined;
  const { chains } = useChains();

  const [initial] = useState(defaultSwapTokens);
  const [pay, setPay] = useState<SwapToken | null>(initial.pay);
  const [receive, setReceive] = useState<SwapToken | null>(initial.receive);
  const [amountText, setAmountText] = useState('');
  const [unknownToken, setUnknownToken] = useState(false);

  const amount = useMemo<AmountParse>(
    () => (pay === null ? { kind: 'empty' } : parseAmount(amountText, pay.decimals)),
    [pay, amountText],
  );
  const pair = pay !== null && receive !== null ? pairSupport(pay, receive, chains) : undefined;
  const ask = useMemo(
    () => quoteAsk({ taker, pay, receive, pair, amount }),
    [taker, pay, receive, pair?.ok, amount],
  );
  const { state: quote, refresh: refreshQuote } = useQuote(ask);

  const [balanceAttempt, setBalanceAttempt] = useState(0);
  const payChain = pay?.ref.chain;
  const targets = useMemo<ChainKey[]>(
    () => (taker !== undefined && payChain !== undefined ? [payChain] : []),
    [taker, payChain],
  );
  const chainList = chains.status === 'ready' ? chains.chains : NO_CHAINS;
  const balances = useBalances(taker, chainList, targets, balanceAttempt);
  const read = payChain === undefined ? undefined : balances.get(payChain);
  const balanceOfPay =
    pay !== null && read?.status === 'ready' ? read.byAddress.get(pay.ref.address) : undefined;
  // A failed read of this one token is no balance at all, not zero.
  const payBalance = typeof balanceOfPay === 'bigint' ? balanceOfPay : undefined;
  const insufficient =
    amount.kind === 'ok' && payBalance !== undefined && amount.units > payBalance;

  const cta = ctaState({
    connected: taker !== undefined,
    pay,
    receive,
    pair,
    amount,
    insufficient,
    quote,
  });

  const setAmount = useCallback(
    (raw: string) => {
      const clean = cleanAmountText(raw, pay?.decimals ?? 0);
      if (clean !== null) setAmountText(clean);
    },
    [pay],
  );

  const flip = useCallback(() => {
    setPay(receive);
    setReceive(pay);
    setUnknownToken(false);
    if (receive === null) return;
    // What was received is what is paid next: the quoted amount when there is one, else the text
    // as typed, cut to the new token's decimals (never rounded up).
    const next =
      quote.status === 'ready'
        ? formatUnitsExact(quote.quote.buyAmount, receive.decimals)
        : fitToDecimals(amountText, receive.decimals);
    setAmountText(next);
  }, [pay, receive, quote, amountText]);

  const select = useCallback(
    (side: Side, ref: TokenRef) => {
      const token = resolveToken(ref);
      const other = side === 'pay' ? receive : pay;
      if (token === undefined) {
        // A token this build does not list cannot be quoted: the side stays empty until a listed
        // one is chosen, and the screen says so.
        setUnknownToken(true);
        if (side === 'pay') setPay(null);
        else setReceive(null);
        return;
      }
      setUnknownToken(false);
      if (other !== null && sameToken(other.ref, token.ref)) {
        flip();
        return;
      }
      if (side === 'pay') {
        setPay(token);
        setAmountText((text) => fitToDecimals(text, token.decimals));
      } else {
        setReceive(token);
      }
    },
    [pay, receive, flip],
  );

  return {
    taker,
    pay,
    receive,
    amountText,
    amount,
    chains,
    pair,
    quote,
    cta,
    payBalance,
    balances,
    unknownToken,
    setAmount,
    select,
    flip,
    refreshQuote,
    refreshBalance: () => setBalanceAttempt((n) => n + 1),
  };
}

const NO_CHAINS: readonly never[] = [];

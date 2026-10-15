import { describe, expect, it } from 'vitest';
import type { ChainsState } from '../../src/lib/picker/use-chains';
import type { ApiChain } from '../../src/lib/api/schemas';
import { ctaLabelId, ctaNote } from '../../src/lib/swap/copy';
import {
  ctaState,
  pairSupport,
  quoteAsk,
  type CtaInput,
  type CtaState,
} from '../../src/lib/swap/model';
import { defaultSwapTokens, resolveToken, sameToken } from '../../src/lib/swap/tokens';
import type { QuoteErrorKind, QuoteState } from '../../src/lib/swap/use-quote';
import { t } from '../../src/lib/i18n';
import en from '../../src/messages/en.json';
import { TAKER, USDC } from './helpers/quote-fixtures';

const { pay, receive } = defaultSwapTokens();
const base = resolveToken({ chain: 'evm:8453', address: 'native' })!;
const chain = (key: 'evm:1' | 'evm:8453', quoting = true): ApiChain => ({
  key,
  name: key === 'evm:1' ? 'Ethereum' : 'Base',
  family: 'evm',
  nativeSymbol: 'ETH',
  balances: true,
  quoting,
});
const ready = (list: ApiChain[]): ChainsState => ({ status: 'ready', chains: list });
const CHAINS = ready([chain('evm:1'), chain('evm:8453')]);
const ok = (units = 5n) => ({ kind: 'ok' as const, units });
const input = (over: Partial<CtaInput> = {}): CtaInput => ({
  connected: true,
  pay,
  receive,
  pair: { ok: true },
  amount: ok(),
  insufficient: false,
  quote: { status: 'loading', after: 'change' },
  ...over,
});

describe('tokens', () => {
  it('opens on the native coin and a stablecoin of the same chain, resolved from the checked-in list', () => {
    expect(pay.symbol).toBe('ETH');
    expect(pay.ref).toEqual({ chain: 'evm:1', address: 'native' });
    expect(pay.decimals).toBe(18);
    expect(receive.ref).toEqual({ chain: 'evm:1', address: USDC });
    expect(receive.decimals).toBe(6);
    expect(receive.tags).toContain('stablecoin');
    expect(sameToken(pay.ref, receive.ref)).toBe(false);
  });
  it('knows no token the list does not list', () => {
    expect(resolveToken({ chain: 'evm:1', address: '0x' + '1'.repeat(40) })).toBeUndefined();
    expect(resolveToken({ chain: 'evm:8453', address: USDC })).toBeUndefined();
  });
});

describe('pairSupport', () => {
  it('one chain that the API quotes on is supported', () => {
    expect(pairSupport(pay, receive, CHAINS)).toEqual({ ok: true });
  });
  it('different chains are not supported yet, whatever the chain list says', () => {
    for (const chains of [CHAINS, { status: 'loading' } as ChainsState]) {
      expect(pairSupport(pay, base, chains)).toEqual({ ok: false, reason: 'cross-chain' });
    }
  });
  it('a chain the API cannot quote on right now is unavailable (also when it is missing from the list)', () => {
    expect(pairSupport(pay, receive, ready([chain('evm:1', false)]))).toEqual({
      ok: false,
      reason: 'chain-unavailable',
    });
    expect(pairSupport(pay, receive, ready([chain('evm:8453')]))).toEqual({
      ok: false,
      reason: 'chain-unavailable',
    });
  });
  it('while the chain list loads nothing is decided, and when it failed the quote itself decides', () => {
    expect(pairSupport(pay, receive, { status: 'loading' })).toEqual({ ok: false, reason: 'loading' });
    expect(pairSupport(pay, receive, { status: 'error', kind: 'network' })).toEqual({ ok: true });
  });
});

describe('ctaState: every state of the button, in order', () => {
  const quotes: [string, QuoteState, CtaState][] = [
    ['idle', { status: 'idle' }, { kind: 'fetching', after: 'change' }],
    ['loading', { status: 'loading', after: 'change' }, { kind: 'fetching', after: 'change' }],
    ['replacing an expired quote', { status: 'loading', after: 'expiry' }, { kind: 'fetching', after: 'expiry' }],
    ['expired', { status: 'expired' }, { kind: 'expired' }],
    ['error', { status: 'error', kind: 'no_route' }, { kind: 'error', error: 'no_route' }],
    [
      'ready',
      {
        status: 'ready',
        quote: { kind: 'wrap', direction: 'wrap', buyAmount: 1n, minBuyAmount: 1n, fee: { bps: 0, reason: 'wrap-unwrap', amount: 0n, waivedUsdCents: 0n } },
        expiry: null,
      },
      { kind: 'review' },
    ],
  ];
  it.each(quotes)('connected with a good amount and a pair: %s', (_n, quote, expected) => {
    expect(ctaState(input({ quote }))).toEqual(expected);
  });

  it('not connected: connect, whatever else is wrong', () => {
    expect(ctaState(input({ connected: false, amount: { kind: 'empty' } }))).toEqual({ kind: 'connect' });
    expect(ctaState(input({ connected: false, pay: null }))).toEqual({ kind: 'connect' });
  });
  it('a side without a token: select a token', () => {
    expect(ctaState(input({ pay: null }))).toEqual({ kind: 'select-token' });
    expect(ctaState(input({ receive: null }))).toEqual({ kind: 'select-token' });
  });
  it('an unsupported pair is said before an amount is asked for', () => {
    expect(
      ctaState(input({ pair: { ok: false, reason: 'cross-chain' }, amount: { kind: 'empty' } })),
    ).toEqual({ kind: 'unsupported-pair', reason: 'cross-chain' });
    expect(ctaState(input({ pair: { ok: false, reason: 'chain-unavailable' } }))).toEqual({
      kind: 'unsupported-pair',
      reason: 'chain-unavailable',
    });
  });
  it.each([
    [{ kind: 'empty' } as const],
    [{ kind: 'zero' } as const],
    [{ kind: 'invalid' } as const],
  ])('%j is "enter an amount"', (amount) => {
    expect(ctaState(input({ amount }))).toEqual({ kind: 'enter-amount' });
  });
  it('a huge amount is too large', () => {
    expect(ctaState(input({ amount: { kind: 'too_large' } }))).toEqual({ kind: 'amount-too-large' });
  });
  it('a balance below the amount says so, before the quote is looked at', () => {
    expect(ctaState(input({ insufficient: true }))).toEqual({ kind: 'insufficient-balance' });
    expect(
      ctaState(input({ insufficient: true, quote: { status: 'error', kind: 'no_route' } })),
    ).toEqual({ kind: 'insufficient-balance' });
  });
  it('while the chain list loads the button is waiting, not an error', () => {
    expect(ctaState(input({ pair: { ok: false, reason: 'loading' } }))).toEqual({
      kind: 'fetching',
      after: 'change',
    });
  });
});

describe('quoteAsk: balances never decide whether a quote is asked for', () => {
  const asked = (over: Partial<Parameters<typeof quoteAsk>[0]> = {}) =>
    quoteAsk({ taker: TAKER, pay, receive, pair: { ok: true }, amount: ok(1_000n), ...over });

  it('builds the request from the wallet, the two tokens and the amount', () => {
    expect(asked()).toEqual({
      sellToken: pay.ref,
      buyToken: receive.ref,
      sellAmount: 1_000n,
      taker: TAKER,
      slippageBps: 50,
    });
  });
  it('is the same whatever the balance is: the input has no balance at all', () => {
    // A balance read, however low, is not an input of `quoteAsk`; the button's own state may say
    // "insufficient balance" while the quote is still asked for and shown.
    const a = asked();
    const withLowBalance = ctaState(input({ insufficient: true }));
    expect(withLowBalance).toEqual({ kind: 'insufficient-balance' });
    expect(asked()).toEqual(a);
    expect(Object.keys({ taker: TAKER, pay, receive, pair: { ok: true }, amount: ok() })).not.toContain(
      'balance',
    );
  });
  it.each([
    ['no wallet', { taker: undefined }],
    ['no pay token', { pay: null }],
    ['no receive token', { receive: null }],
    ['a pair that cannot be quoted', { pair: { ok: false, reason: 'cross-chain' } as const }],
    ['a chain list still loading', { pair: { ok: false, reason: 'loading' } as const }],
    ['no amount', { amount: { kind: 'empty' } as const }],
    ['a zero amount', { amount: { kind: 'zero' } as const }],
    ['an amount that is too large', { amount: { kind: 'too_large' } as const }],
    ['no pair at all', { pair: undefined }],
  ])('asks nothing for %s', (_n, over) => {
    expect(asked(over)).toBeNull();
  });
});

describe('button labels and notes: every state has copy in the message file', () => {
  const errors: QuoteErrorKind[] = [
    'no_route',
    'routing_slow',
    'price_unavailable',
    'routing_unavailable',
    'signing_unavailable',
    'unavailable',
    'network',
    'offline',
    'timeout',
    'unconfigured',
    'clock',
  ];
  const states: CtaState[] = [
    { kind: 'connect' },
    { kind: 'select-token' },
    { kind: 'unsupported-pair', reason: 'cross-chain' },
    { kind: 'unsupported-pair', reason: 'chain-unavailable' },
    { kind: 'enter-amount' },
    { kind: 'amount-too-large' },
    { kind: 'insufficient-balance' },
    { kind: 'fetching', after: 'change' },
    { kind: 'fetching', after: 'expiry' },
    { kind: 'expired' },
    { kind: 'review' },
    ...errors.map((error): CtaState => ({ kind: 'error', error })),
  ];
  const ctx = { payChain: 'Ethereum', receiveChain: 'Base', balance: '0.0841', paySymbol: 'ETH', unknownToken: false };

  it.each(states.map((s) => [JSON.stringify(s), s] as const))('%s', (_n, state) => {
    expect(Object.keys(en)).toContain(ctaLabelId(state));
    expect(t(ctaLabelId(state)).length).toBeGreaterThan(0);
    const note = ctaNote(state, ctx);
    if (note) {
      expect(Object.keys(en)).toContain(note.id);
      expect(t(note.id, note.params)).not.toMatch(/\{\w+\}/);
    }
  });

  it('the insufficient balance note says it is the last read, not a fact', () => {
    const note = ctaNote({ kind: 'insufficient-balance' }, ctx)!;
    expect(t(note.id, note.params)).toBe(
      'Your last balance read on Ethereum was 0.0841 ETH, below this amount. Balances can be out of date.',
    );
    expect(note.action).toBe('balance');
  });
  it('errors that a retry can fix offer one, the others do not', () => {
    const retry = (error: QuoteErrorKind) => ctaNote({ kind: 'error', error }, ctx)?.action;
    for (const e of ['routing_slow', 'price_unavailable', 'network', 'offline', 'timeout', 'unavailable', 'clock'] as const) {
      expect(retry(e), e).toBe('retry');
    }
    expect(retry('no_route')).toBeUndefined();
    expect(retry('unconfigured')).toBeUndefined();
  });
  it('the unsupported pair note names both chains from the registry', () => {
    const note = ctaNote({ kind: 'unsupported-pair', reason: 'cross-chain' }, ctx)!;
    expect(t(note.id, note.params)).toBe(
      'Swaps between Ethereum and Base are not supported yet. Choose two tokens on the same network.',
    );
  });
  it('the final button says so when it does nothing', () => {
    expect(ctaNote({ kind: 'review' }, ctx)?.id).toBe('swap.note.review');
  });
});

describe('copy has no typed numbers or promises', () => {
  // Messages of the quote flow may not carry a digit, a percent sign or a dollar sign: amounts,
  // rates, fees and times are always parameters filled from the API or the shared packages. The
  // only digit is the "1" of "1 {token}" (one whole token, the unit of a rate), and the "1 to 1" of
  // a wrap, which is exact by the definition of the contract call.
  const swapMessages = Object.entries(en).filter(([id]) => id.startsWith('swap.'));
  it.each(swapMessages)('%s', (id, text) => {
    if (['swap.route.wrap', 'swap.route.unwrap', 'swap.amount.placeholder'].includes(id)) return;
    expect(text.replaceAll('1 {', '{'), id).not.toMatch(/\d|%|\$/);
  });
  it('the fee and tier texts are filled from the schedule, not typed', () => {
    for (const id of ['swap.details.fee.reason.tier', 'swap.details.fee.reason.first-swap-promo'] as const) {
      expect(en[id]).toMatch(/\{\w+\}/);
    }
  });
});

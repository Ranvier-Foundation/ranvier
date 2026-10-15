# ADR 0011: Quote display data flow (web)

- Status: accepted
- Date: 2026-10-15

## Context

The swap screen now asks `POST /v1/quotes` and shows the answer: the amount received, the rate, the fee, the minimum received, the network cost, the route and a countdown. It stops there. There is no review screen, no signing, no sending and no transaction building in this change; a later change, reviewed separately, will do those.

The answer of `/v1/quotes` is mostly not for display. It carries the router call (`best.tx`, with calldata), every provider's quote, the signed fee-wrapper quote (`swap.quote`), the signature and the ready-to-sign transaction (`swap.transaction`). Three things shape how the browser may use it:

- **Whatever the page keeps can leak or be misused.** Calldata and a signature in a log, a store, the DOM or a state tree are material for a later bug (or a hostile script, see ADR 0008) to forward. The strict CSP does not make them safe to keep.
- **An answer can be for something else than what was asked,** through a bug, a cache or a hostile API. The user must never see numbers that belong to another amount, wallet or token.
- **Money maths must be exact, and time is not the device's.** Amounts are `bigint` base units, USD is integer cents (CLAUDE.md). The expiry is an absolute time written with the server's clock.

## Decision

### What is parsed, and what is dropped at parse time

`apps/web/src/lib/api/quote.ts` reads the answer from `unknown`, field by field, into a small typed value (`ApiQuote`). Only these fields are read and copied:

- the fee: `fee.bps`, `fee.reason`, `fee.amount`, `fee.waivedUsd`;
- for a routed swap: `best.provider` (text), `best.buyAmount`, `best.minBuyAmount`, `best.buyAmountUsd`, `best.gasCostUsd`, the number of entries in `quotes`, and `swap.quote.deadline`;
- for a direct wrap or unwrap: `direct.kind`, `direct.buyAmount`, `direct.minBuyAmount`.

`swap.quote.user`, `tokenIn`, `tokenOut`, `amountIn`, `feeAmount` and `minAmountOut` are read only to check the answer (below) and are not kept.

Everything else is never read, so it cannot be kept, forwarded, stored, logged or rendered: `best.tx` and its calldata, `best.route`, the other providers' quotes, `failures`, `swap.signature`, `swap.transaction`, `swap.quote.router`, `routerCalldataHash`, `nonce`, and `direct.transaction`. Unknown new fields are ignored the same way. Tests assert that the parsed value contains none of them (by key and by serialised text), and an e2e test asserts that none of their text is in the DOM, in `localStorage`, `sessionStorage`, `window.name`, the URL or the console. Amounts are decimal strings of at most uint256 turned into `bigint`; USD values are integer cents. Text from the API (the provider name) is length-bounded, refused if it holds control, format or separator characters, and rendered as React text, never as a URL, `src`, `href` or markup.

A response that does not match is refused whole (`ApiError('invalid')`, shown as "Quote unavailable"): never repaired, never partly shown.

### The answer must be the one that was asked for

- The answer must be exactly one of a routed swap (with the signed quote) or a direct wrap. An answer with neither is an unsigned quote (the API has no signer): there is no fee to trust, so no quote is shown.
- `swap.quote` must echo the taker (compared without case), the sell and buy token (the zero address stands for the native coin) and the sell amount. The signed `feeAmount` must equal `fee.amount` and the signed `minAmountOut` must equal `best.minBuyAmount`, so the fee and the minimum on screen are the ones the API signed.
- A direct wrap must say `wrap` for a sold native coin and `unwrap` for a sold wrapped token, and its output and minimum must equal the sell amount (1:1).
- The fee must be one the schedule can produce, checked against `@ranvier/fees` (no number is typed in the app): a rate on the schedule for its reason and under the contract cap (`FEE_SCHEDULE.maxBps`), and the amount `feeAmount(sellAmount, bps)` exactly (a first-swap waiver may charge less, never more, with a waived value above zero and not above `firstSwapFreeUsd`). A fee outside the schedule is refused. A wrap fee reason on a routed swap, and a charged wrap, are refused.
- The answer carries no chain keys. The chain is bound by pairing the answer with its own request (one request, one answer) and by dropping late answers (below). Recorded as an API gap.

### Requests

`fetchQuote` follows the client conventions of ADR 0010: `credentials: 'omit'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, a timeout, a size cap, a `200` and `application/json` check. The wallet address (`taker`) is in the POST body only. The body holds `{ chain, address }` for each token (never symbol or decimals, which the API refuses, ADR 0004), the amount as a decimal string, the taker and `slippageBps`. An error answer is read (capped, JSON only) for one stable code from a closed set (`invalid_request`, `no_route`, `price_unavailable`, `routing_unavailable`, `signing_unavailable`, `internal_error`); no text of the body is kept, and a `no_route` whose every provider timed out or failed upstream becomes `routing_slow` ("try again" instead of "change the amount").

Slippage is one constant for "Auto" (`AUTO_SLIPPAGE_BPS`, 50, the canvas's "Auto · 0.5%"); it is not shown as a number here. Smart slippage and the settings screen are later work.

### Amounts

The typed text is a decimal string. It is cleaned on every edit (`cleanAmountText`): ASCII digits and one decimal point only, comma grouping accepted only in the thousands form, at most `MAX_AMOUNT_CHARS` (80) characters, no more fraction digits than the token has decimals and no decimal point for a token with 0 decimals. A refused edit leaves the field as it was. The base units are computed with `bigint` (`parseAmount`): exact, nothing rounded, zero is "enter an amount", more than uint256 is "amount too large". A token change cuts the text to the new decimals (never rounds). ESLint bans `Number()`, `parseFloat`, `Math` rounding, unary plus, float formatting and decimal literals in the three money-path files (`swap/amount.ts`, `swap/rate.ts`, `api/quote.ts`). Decimals come from the checked-in token list (`@ranvier/chains`), the same list the API cross-checks the oracle against (ADR 0004, ADR 0006). The rate is `numerator * 10^decimals / denominator` in `bigint`, truncated.

### Stale answers

Every quote request belongs to a session of the parameters (sell token, buy token, amount, taker, slippage). A change of any of them ends the session and aborts its request; an answer that arrives after its session ended is dropped even if the client resolved anyway (including the case of parameters that go A, B, A, where the first A's answer must not land on the second A). The render for new parameters never returns the previous parameters' state, not even for the one render before the effect runs. A wallet that changes (or disconnects) mid-quote is a change of parameters. Typing is debounced (`QUOTE_DEBOUNCE_MS`). Errors are not retried by themselves. The unit tests (`swap-quote-hook.test.tsx`) prove each guard by mutation: twelve mutations of `use-quote.ts` (each guard removed, the abort removed, the render guard removed, the idle cap removed, the hidden-tab rule removed, the clock-error branch removed, the key's case folding removed, the visibility listener removed, the typing pause kept on refresh, a wrap given an expiry) each fail at least one test. The e2e tests show the same at the page level with answers that outlive their abort.

### Expiry and the clock

The API sends one absolute deadline (`swap.quote.deadline`, unix seconds, the server's clock; the signing validity is 60 seconds by default and configurable from 10 to 600 seconds). It does not send the server's time or a duration, and the browser cannot read the `Date` header (CORS exposes no headers, ADR 0006). The device clock may be off by any amount, so the deadline is never compared with "now" while the quote is on screen. What the screen does:

1. **One wall-clock reading, at arrival.** Time left on arrival is `deadline - Date.now()`.
2. **A cap, counted from the request.** The quote is never shown as valid for longer than `QUOTE_LIFETIME_CAP_MS` (60 s) counted from the moment the request was sent (the server wrote the deadline somewhere between sending and arrival). A device clock that runs behind would otherwise show a quote as valid for far longer than the server meant. A longer API setting only means an earlier refresh.
3. **A clock that runs ahead.** If nothing is left on arrival, the device clock is ahead of the server's by more than the whole lifetime. Refetching would produce the same dead quote forever, so this is shown as "Check your clock" and nothing is asked again by itself.
4. **A countdown on the monotonic clock** (`performance.now`), so setting the device clock afterwards changes nothing. Time left is the lesser of the monotonic reading and the lifetime minus the wall time since arrival: a clock set backwards cannot lengthen a quote, a clock set forwards only expires it early, and a device that slept (the monotonic clock may pause) is seen by the wall clock. On waking (`visibilitychange`) a quote that ran out is replaced.
5. **Replacement.** An expired quote is replaced at once, up to `MAX_IDLE_REFRESHES` times in a row and only while the tab is visible (every quote can cost a paid upstream call). Then the button reads "Get a new quote" and waits for the person. Touching the amount, a token or the wallet, pressing the button, or coming back to the tab starts the count over. A direct wrap has no deadline (it is exact and unsigned) and is never replaced.

The countdown text is not a live region. Screen readers hear one announcement per quote ("Quote ready...") and one per change of the note under the button, not one per second or per keystroke (the `<output>` of the receive amount is `aria-live="off"`).

If the API sent its time (or the validity in seconds) with the quote, steps 2 and 3 would shrink to subtracting a measured skew. Recommended as an API change; not made here.

### Balances are display only

The balances come from `POST /v1/balances` (ADR 0009) and may be wrong, late or from a lying provider. They are used in exactly one place: a hint on the button when the last read is below the typed amount ("Insufficient balance", with a note that says it is the last read and can be out of date, and a button to read it again). They never decide whether a quote is asked for or shown (`quoteAsk` has no balance input; a test and an e2e test prove it), and a failed or unavailable read blocks nothing. The balance is read only once an amount is typed, for the pay chain only, so a screen nobody typed on sends no wallet address to the API (the quote request sends it anyway as soon as there is an amount). The future review screen must not trust them either (ADR 0009): amounts there come from the wallet and a simulation. Whether a below-balance state should block or only warn on the review screen is open; today the final button is disabled for another reason.

### Chains and pairs

Only same-chain EVM pairs are quoted (ADR 0004). A pair on two chains shows "Pair not supported yet", derived from the two tokens' chains and named from the registry; a chain whose `quoting` flag in `GET /v1/chains` is false shows "Network unavailable". Neither asks for a quote. If the chain list could not be read, the pair is tried and the quote answer says what is wrong. The screen opens on one chain (ETH to USDC on Ethereum), not the canvas's cross-chain pair, because a default that cannot be quoted would promise something the system does not do. Picking the token already on the other side swaps the two. A token the picker returns that this build's list lacks leaves its side empty ("Select a token") instead of being guessed. The wallet's network does not matter to a quote and does not trigger one.

### The final button

When a fresh quote is on screen the button reads "Review swap", is disabled, and a note under it says "Review and signing are not available yet." It does nothing. There is no review route.

## Consequences

- API gaps found while building this (not changed here; each would shrink client code): the answer has no chain keys (the chain is bound only by pairing); no USD value of the sold amount (so the pay row shows none once an amount is typed, and the canvas's "(-0.29%)" price impact and "Gas, bridge and LP" total are not shown); no server time or validity duration (the clock approach above); a direct wrap answer echoes nothing but the amounts.
- The itemised fee list is the Ranvier fee, the network cost (an estimate) and the minimum received. Bridge fee, liquidity provider fees, price impact and a total (handoff content rules) need data the API does not send; they are not invented.
- The token list in the web bundle and the API's list are the same checked-in list from one release, but a web build older than the API can lack a newly listed token (the screen says so).
- The "Auto" slippage is one constant until smart slippage exists.
- The first-swap waiver is shown from the answer (`waivedUsd`), not from a typed number.
- Later work that signs must fetch and review `tx`, `swap.transaction` and the signature on its own, treat the wallet's prompt as the trust anchor and re-verify amounts by simulation (ADR 0009).

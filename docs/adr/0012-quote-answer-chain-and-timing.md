# ADR 0012: Quote answer echoes its chain and timing

- Status: accepted; the web enforces this (see "Web enforcement")
- Date: 2026-10-15

## Context

Before the web app signs and sends swaps, a security review found two gaps in the answer of `POST /v1/quotes` (ADR 0011 recorded both as API gaps):

- **B1: the answer carried no chain.** The web checks that the signed quote echoes the taker, the tokens and the amounts it asked for. Those checks cannot tell chains apart: the native coin is the zero address on every EVM chain, and some tokens (cbBTC, for one) have the same address on several chains. An answer built and signed for one chain could pass every check for another. The signature would then verify only on the chain it was made for, and the wallet's chain prompt would be the last guard.
- **M1: the client could not know the real lifetime.** The answer sent only the absolute `deadline` (server clock). The web caps a quote's lifetime at 60 s counted from when it sent the request, which bounds the quote only if the signed lifetime is at least 60 s. `QUOTE_TTL_SECONDS` accepts 10 to 600.

## Decision

### New top-level fields (additive)

A **signed swap answer** gains five fields, and a **direct wrap/unwrap answer** gains the three chain fields. Nothing else changes: the signed `SwapQuote` struct, the EIP-712 domain, the contract, the fee logic and the golden vectors are untouched, and every existing field keeps its name, place and meaning.

| Field        | Type   | Signed swap | Direct wrap | Meaning                                                                                               |
| ------------ | ------ | ----------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `sellChain`  | string | yes         | yes         | The request's `sellToken.chain`, as validated (`evm:<chain ID>`).                                     |
| `buyChain`   | string | yes         | yes         | The request's `buyToken.chain`, as validated. Equal to `sellChain` today (same-chain EVM only).       |
| `chainId`    | number | yes         | yes         | Signed swap: the EIP-712 domain `chainId` the signature was made with. Wrap: the transaction's chain. |
| `serverTime` | number | yes         | no          | Unix seconds: the server clock reading the signed `deadline` was computed from.                       |
| `ttlSeconds` | number | yes         | no          | The signed lifetime (`QUOTE_TTL_SECONDS`). Always `swap.quote.deadline == serverTime + ttlSeconds`.   |

An unsigned answer (no signer configured) is unchanged and carries none of these; the web refuses it anyway (ADR 0011). Error answers are unchanged.

The types are `QuoteChainEcho` and `QuoteTimingEcho` in `@ranvier/types`.

Example of a signed swap answer (values from the test suite; calldata, hash and signature shortened; `quotes` holds the same entry as `best`):

```json
{
  "fee": { "bps": 20, "reason": "tier-under-10k", "amount": "2000000000000000", "waivedUsd": "0" },
  "best": {
    "provider": "fake",
    "buyAmount": "1996000000",
    "minBuyAmount": "1986020000",
    "buyAmountUsd": "200000",
    "gasCostUsd": "50",
    "route": [],
    "tx": {
      "to": "0x0000000000001ff3684f28c67538d4d072c22734",
      "data": "0x2213bc0b...",
      "value": "998000000000000000"
    }
  },
  "quotes": ["..."],
  "failures": [],
  "swap": {
    "quote": {
      "user": "0x00000000000000000000000000000000000000AA",
      "tokenIn": "0x0000000000000000000000000000000000000000",
      "tokenOut": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "amountIn": "1000000000000000000",
      "minAmountOut": "1986020000",
      "feeAmount": "2000000000000000",
      "router": "0x0000000000001fF3684f28c67538d4D072C22734",
      "routerCalldataHash": "0xb5f6...0a9f",
      "nonce": "9",
      "deadline": "1800000060"
    },
    "signature": "0x8c09...9b1b",
    "transaction": {
      "to": "0x000000000000000000000000000000000000fee1",
      "data": "0xa705a9ad...",
      "value": "1000000000000000000"
    }
  },
  "sellChain": "evm:1",
  "buyChain": "evm:1",
  "chainId": 1,
  "serverTime": 1800000000,
  "ttlSeconds": 60
}
```

A direct wrap answer:

```json
{
  "fee": { "bps": 0, "reason": "wrap-unwrap", "amount": "0", "waivedUsd": "0" },
  "direct": {
    "kind": "wrap",
    "transaction": {
      "to": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "data": "0xd0e30db0",
      "value": "1000000000000000000"
    },
    "buyAmount": "1000000000000000000",
    "minBuyAmount": "1000000000000000000"
  },
  "sellChain": "evm:1",
  "buyChain": "evm:1",
  "chainId": 1
}
```

Amounts stay decimal strings. `chainId`, `serverTime` and `ttlSeconds` are JSON numbers: they are small integers (chain IDs and unix seconds are far below 2^53), not money.

### Where the values come from

- **Chain.** `sameChainEvmContext(request)` (`apps/api/src/domain/swap-quote.ts`) derives `{ sellChain, buyChain, chainId }` from the validated request. `buildSignedSwap` uses that one object for the signer's chain check and for the EIP-712 domain, and returns it as `context`. The HTTP layer echoes that returned context, never a value recomputed from provider output.
- **Timing.** The handler reads the clock once (`serverTime`), computes the deadline with `signedDeadline({ serverTime, ttlSeconds })`, and passes it to `buildSignedSwap`.
- **Cross-check before sending.** `signedAnswerEcho` (`apps/api/src/domain/quote-answer.ts`) checks that the context equals the context of the request and that `swap.quote.deadline == serverTime + ttlSeconds`. A mismatch is a server bug: it throws, the client gets `500 internal_error`, and nothing signed is sent. A wrap's echo comes from `directAnswerEcho(request)`, which refuses anything but a same-chain EVM request.
- `swap` is serialised as exactly `quote`, `signature` and `transaction`; the context is not repeated inside it. The new fields carry nothing from providers: no router, calldata, provider name or route.

### What a client must do

- **Chain.** Refuse an answer unless `sellChain` and `buyChain` equal the chain keys it asked for and `chainId` is that chain's numeric ID. When it signs, the wallet's chain must equal `chainId`.
- **Time.** The signed `deadline` is authoritative: the contract refuses the swap after it (by block timestamp). Refuse an answer where `deadline != serverTime + ttlSeconds` or `ttlSeconds` is outside 10..600. Count the remaining time on the monotonic clock from the moment the request was sent, with a lifetime of `min(ttlSeconds, client cap)` (the web's cap is 60 s). The server read `serverTime` after the request was sent (in real time), so this is never longer than the server meant, whatever the device clock says. `serverTime` also gives the device clock's skew, if a client wants to show it.

### `QUOTE_TTL_SECONDS` stays 10 to 600, default 60

The minimum is not raised. Reasons:

- With `ttlSeconds` in the answer, `min(ttlSeconds, 60)` counted from the request is correct for every allowed value, so the 60 s assumption is no longer needed for the bound.
- A short lifetime is a real operator lever: it narrows the window in which a signed quote can be used against a moving price.
- Raising the minimum would make a configuration that starts today refuse to start after an upgrade.
- An expired quote costs nothing but a reverted transaction: the contract enforces the deadline.

The trade-off: a very short lifetime (under about 30 s) leaves little time to review and confirm in a wallet, especially a hardware wallet, so quotes expire before people can sign. Production with the web app should use 30 s or more; the default stays 60 s. The web reads `ttlSeconds` and follows any lifetime in the range (see "Web enforcement"), so the API has no minimum other than the 10 s the configuration allows; a short lifetime only means a shorter countdown.

## Consequences

- The web closes the B1 and M1 gaps from ADR 0011 with these fields (see "Web enforcement"). A web build older than this change ignores them, and an API that stops sending them is refused by the current web build.
- `buildSignedSwap` returns its `context` too. Callers that serialise its result must list fields, as the server does.
- The deadline is still computed from the server clock, not from chain time. A server clock that drifts from block timestamps shortens or lengthens the real lifetime; keep the server on NTP.

## Web enforcement

Status: the web enforces this (`apps/web/src/lib/api/quote.ts`, `lib/swap/expiry.ts`, `lib/swap/use-quote.ts`; bounds in `lib/swap/config.ts`).

**Parser.** The echo is required, and the whole answer is refused (shown as "Quote unavailable", nothing of it rendered) unless:

- `sellChain` and `buyChain` equal the chain keys of the request, exactly (no case folding, no padding), and the request is a same-chain EVM request on a chain in the checked-in registry;
- `chainId` is the numeric ID of that chain, derived from the registry key (`evm:<id>`) by the web, never from the answer. An answer for Base that says `chainId: 1` is refused, and so is `chainId` as text;
- for a signed swap, `serverTime` and `ttlSeconds` are safe integers, `ttlSeconds` is within `QUOTE_TTL_MIN_SECONDS` to `QUOTE_TTL_MAX_SECONDS` (10 to 600, named once in `config.ts` beside the API's documented range), and `swap.quote.deadline == serverTime + ttlSeconds`, compared as `bigint`;
- a direct wrap needs the chain echo only; a wrap that carries `serverTime` or `ttlSeconds` is refused (they have no meaning without a signature). Unknown other fields are still ignored, as before, and every signing and transaction field is still dropped at parse time.

**Countdown.** A quote is shown for `min(ttlSeconds, 60 s cap) - 1 s`, counted from the moment the request was sent, on the monotonic clock. The cap is the web's own choice (`QUOTE_LIFETIME_CAP_MS`); a longer API lifetime only means an earlier refresh. The one second is the API's whole-second clock: it writes `deadline = floor(its clock) + ttl` after the request was sent, so `sent + ttl` can be up to 1 s after the signed deadline, and `sent + ttl - 1 s` cannot. (The earlier wording here, "never longer than the server meant", was true up to that second.) An answer that took as long as the lifetime is not shown: it is replaced like an expired quote, and counts toward the three automatic replacements, so a slow API cannot make a loop.

**Does the countdown use the server's remaining time?** No. It uses only the monotonic clock from the send, and the existing wall-clock guard (the lesser of the two readings: a clock set back, a clock set forward and a device that slept cannot lengthen a quote). Reasons:

- The server's remaining time is `serverTime + ttl - serverNow`, and the client knows `serverNow` only through its own wall clock and a skew estimated from one answer. That estimate is uncertain by the round trip plus the 1 s the server floored away, in the direction that can overstate the time left. The send-anchored monotonic count has no such uncertainty: the server read its clock after the send.
- A server-derived remaining time could only be used safely as another `min`. It would then change the result only when the estimate is below the monotonic count, which is exactly when the estimate is wrong or the clocks disagree, and that case is reported as an error instead (below). So it adds a second way to be wrong and no safety.
- Showing an expired quote as valid, or a loop against the API, needs the countdown to run longer than the quote or to refetch without a bound. Neither can happen here: the end is fixed on the monotonic clock at arrival, and replacements are capped.

**Clock disagreement.** On arrival the web checks `serverTime` against the device's wall clock, using the interval the server's reading must lie in (the device clock at the send, to the device clock at the arrival, with `serverTime` floored to seconds), so a slow answer is never mistaken for skew. If even the nearest possible skew is beyond `CLOCK_SKEW_TOLERANCE_MS` (30 s), in either direction, the screen shows "Check your clock", shows no quote and asks nothing again by itself. This replaces ADR 0011's rule (a deadline already past on the device clock), which only caught a device that ran ahead, and only by more than the lifetime. It is symmetric because a server clock that is far from real time produces a signed deadline that is dead or long-lived on chain, and the person cannot tell which clock is wrong; the copy says the device clock looks wrong. Trade-off: a device off by more than 30 s cannot get a quote until it is fixed, though the countdown would still have been right. The tolerance is one constant.

A direct wrap has no lifetime and is never replaced.

# ADR 0012: Quote answer echoes its chain and timing

- Status: accepted
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

The trade-off: a very short lifetime (under about 30 s) leaves little time to review and confirm in a wallet, especially a hardware wallet, so quotes expire before people can sign. Production with the web app should use 30 s or more; the default stays 60 s. Until the web reads `ttlSeconds` (a separate web change), the deployed web assumes at least 60 s, so the API must not run below 60 s with it. Today that only affects the display: the web does not sign yet.

## Consequences

- The web can close the B1 and M1 gaps from ADR 0011 without guessing. That is a separate change; until then the new fields are ignored (the web parser ignores unknown fields).
- `buildSignedSwap` returns its `context` too. Callers that serialise its result must list fields, as the server does.
- The deadline is still computed from the server clock, not from chain time. A server clock that drifts from block timestamps shortens or lengthens the real lifetime; keep the server on NTP.

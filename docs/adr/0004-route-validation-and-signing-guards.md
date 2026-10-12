# ADR 0004: Route validation and signing guards

- Status: accepted
- Date: 2026-10-12

## Context

A security review of the quote API found that the backend trusted inputs it must not trust:

- The client's token `decimals` set the USD value of the swap, and so the fee tier and the first-swap waiver.
- The backend signed whatever router calldata and minimum output 0x returned. The fee wrapper only checks that the router is allowlisted, that the calldata matches the signed hash, and that the user received the signed minimum. A compromised, intercepted or buggy 0x response could therefore name an attacker contract as AllowanceHolder `operator`/`target`, set the minimum to 0, and still pass every on-chain check.
- `LocalKeySigner` refused to start only when `NODE_ENV` was exactly `production`, while the default chains were mainnets.

## Decision

### Trusted token data

- Requests name tokens by `chain` and `address` only. `symbol` and `decimals` are no longer accepted. The token schema is strict, so sending them returns `400 invalid_request` rather than being silently ignored.
- Decimals come from the price oracle: DefiLlama's `decimals` metadata for tokens, and `ChainConfig.nativeDecimals` in `@ranvier/chains` for the native coin (18 on EVM, 9 for SOL). A token without trusted decimals has no price, and no quote is offered.
- Oracle prices are parsed from the exact JSON number text (JSON.parse source-text access) into an integer at 10^18 scale, rounded down. Floats are never used. A price that is zero, negative or below 10^-18 USD is rejected. Prices are cached per token for 30 seconds in a bounded cache (1,000 entries, oldest evicted first).
- EVM token and taker addresses are validated and lowercased at the HTTP edge (`native` or `0x` + 40 hex characters). Solana addresses must be `native` or base58 of 32 to 44 characters. Every later lookup, including swap history, uses the normalised form.

### Every route is vetted before it is offered or signed

`vetRoute` (`apps/api/src/domain/route-safety.ts`) runs on every provider quote inside the orchestrator. A route that fails any check is dropped with the client code `rejected_unsafe_route`; the reason is logged server-side. Only a `VettedRoute` can be passed to `buildSignedSwap`. The checks are:

1. **Chain.** Same-chain EVM only. Any other route is refused until it has its own checks.
2. **Router.** `tx.to` must be a trusted router for that chain (`apps/api/src/trusted-routers.ts`). Today that means 0x AllowanceHolder `0x0000000000001fF3684f28c67538d4D072C22734`.
3. **AllowanceHolder calldata.** The calldata must decode as `exec(address operator, address token, uint256 amount, address target, bytes data)`, selector `0x2213bc0b`, and:
   - `operator == target`;
   - `target` is one of the trusted 0x Settlers for that chain;
   - `token` is the input token. For native input this is the zero address, as verified on mainnet transactions to the 0x Settler; the `0xeeee...eeee` sentinel is refused as an input token;
   - `amount == sellAmount - fee`, which is exactly what the wrapper forwards.
4. **Settler calldata.** The inner `data` must decode as Settler `execute((address recipient, address buyToken, uint256 minAmountOut), bytes[] actions, bytes32 zid)`, selector `0x1fff991f`, and:
   - `recipient` is the user;
   - `buyToken` is the output token, with `0xeeee...eeee` for native output;
   - `minAmountOut` equals the minimum the provider reported.
5. **Value.** `tx.value` is `sellAmount - fee` for native input and 0 otherwise.
6. **Minimum output.**
   - `buyAmount` must be greater than 0.
   - `minBuyAmount` must be no greater than `buyAmount`.
   - `minBuyAmount` must be at least `floor(buyAmount * (10000 - slippageBps) / 10000)`. 0x rounds its own minimum down, so this floor matches it.
   - The signed `minAmountOut` is `max(minBuyAmount, ceil(buyAmount * (10000 - slippageBps) / 10000))`, so rounding favours the user. The wrapper enforces this value.
7. **Oracle bound.** The oracle value of `buyAmount` may fall short of the oracle value of `sellAmount - fee` by at most `MAX_ORACLE_DEVIATION_BPS` (default 500, which is 5%). The comparison uses attoUSD and exact cross-multiplication, so small swaps are not rounded to cents. Both prices are fetched before any paid provider call. If the buy token has no price, the request fails with `503 price_unavailable` and the check is never skipped.

`slippageBps` is capped at `MAX_SLIPPAGE_BPS` (default 1000, which is 10%; configurable, hard maximum 5000).

### Trusted 0x Settlers: config, not RPC

0x Settler contracts are redeployed and rotated through the 0x Deployer registry at `0x00000000000004533Fe15556B1E086BB1A72cEae` on every chain. `ownerOf(2)` is the current taker-submitted Settler, and `prev(2)` is the previous one, which is still served while a new one dwells. 0x recommends that integrators read the registry. We use a per-chain allowlist in code (`ZEROX_SETTLERS` in `apps/api/src/trusted-routers.ts`) holding the current and previous Settler, for these reasons:

- No RPC dependency in the quote path. An RPC endpoint would itself become trusted input: a compromised RPC could name an attacker contract.
- Changes are deliberate. Every change is a reviewed PR that goes to the security reviewer.
- It fails closed. When 0x rotates, quotes that use a Settler outside the list are refused (`unknown_target`) until the list is updated. A stale list loses availability; it never risks funds. A Settler that 0x pauses reverts on-chain, and the wrapper reverts the whole swap.

The values in the list were read from the registry on 2026-10-12. On Base, the Settler in the recorded 0x fixture had already become `prev(2)` by then, so rotations do happen. The update procedure is in [docs/runbooks/zerox-settler-rotation.md](../runbooks/zerox-settler-rotation.md). Planned follow-up: a worker job that compares the list with the registry (read-only, alerting only) so a rotation is noticed within minutes. It must never update the list automatically.

### Local signing keys never sign for mainnets

- `LocalKeySigner` signs only for an explicit allowlist of chain IDs. The default is 84532 (Base Sepolia), 11155111 (Sepolia), 421614 (Arbitrum Sepolia) and 31337 (Anvil/Hardhat), configurable with `LOCAL_SIGNER_CHAIN_IDS`.
- Mainnets can never be on that allowlist: 1, 10, 56, 137, 8453, 42161, 43114, plus every EVM chain in the registry. Constructing a signer that includes one throws, and signing for a chain outside the list throws.
- `NODE_ENV=production` is still refused as well.
- At startup, `main.ts` fails with a clear message if a local key is set and `ZEROX_CHAIN_IDS` includes a chain the key may not sign for. Because the default `ZEROX_CHAIN_IDS` are mainnets, a local key now needs an explicit testnet or fork configuration.
- For end-to-end tests against mainnet state, use an Anvil fork running under chain ID 31337 with a throwaway key. Not built yet: 0x quotes only real chains, so a fork mode that quotes chain 1 but signs for 31337 needs its own reviewed design.

### Client-facing errors

- Provider failures are returned as `{ provider, error }`. The codes are `timeout`, `no_liquidity`, `upstream_error`, `invalid_response` and `rejected_unsafe_route`. Details go to the server log as an error name and a message bounded to 200 characters. The log never includes the API key, signer key or full calldata.
- Unexpected errors return `500 { error: "internal_error" }`. Framework 4xx errors return `invalid_request` or `payload_too_large`, and unknown routes return `not_found`.

## Consequences

- A compromised 0x response can at worst offer a route within the user's slippage and within the oracle bound. It cannot redirect the input, the output or the allowance.
- Fail-closed costs availability:
  - quotes stop on a chain after a Settler rotation until the list is updated;
  - tokens without a DefiLlama price or decimals cannot be traded;
  - exotic or illiquid pairs whose real execution price differs from the oracle by more than 5% are refused.
  - The bound assumes the oracle is right. A stale but still in-window DefiLlama price can refuse fair routes or, within 5%, accept unfair ones. The minimum-output floor still protects the user against the quoted output.
- Each new provider or router kind needs its own calldata checks in `route-safety.ts` before any of its routes can be offered. Until then its routes are refused.
- Breaking API change: the request token objects lose `symbol` and `decimals`, and failures lose `message`.

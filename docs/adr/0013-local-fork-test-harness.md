# ADR 0013: Local chain test harness for signing and sending

- Status: proposed (design only; nothing here is built yet)
- Date: 2026-10-15

## Context

The web signing flow (review, ERC-20 approval, FeeWrapper swap, simulation, confirmation) cannot run end to end today:

- 0x does not quote testnets or local chains.
- `LocalKeySigner` refuses every mainnet (ADR 0004, `NEVER_LOCAL_CHAINS`), and mainnet signing needs a KMS key (ADR 0005) and two audits.
- The wrapper is not deployed on Base Sepolia yet.

The owner chose a **local harness first**: the whole flow on a local chain, with no live testnet and no secrets. Base Sepolia (option a) comes later.

### Evidence (spikes run on 2026-10-15, anvil/forge 1.8.3; nothing committed but this ADR and the runbook)

1. **Plain anvil, unchanged production code, real swap.** `anvil --chain-id 31337` was started. The Arachnid CREATE2 factory `0x4e59…956c` is present at genesis. Mock tokens, a mock AllowanceHolder and a mock Settler were deployed with a fixed CREATE2 salt. `contracts/script/Deploy.s.sol` was run **unchanged** (fee signer = anvil account 1). A TypeScript script then called the API's own `quoteFee`, `vetRoute` (with an injected route policy for 31337), `LocalKeySigner`, `canSignChain` and `buildSignedSwap`, and sent approve + `swap` with viem. Results:
   - `vetRoute` accepted the route. The fee was 20 bps (0.002 hWETH) and the signed minimum was 2979.03 hUSDC.
   - `canSignChain(31337)` was true and `canSignChain(8453)` was false. `new LocalKeySigner(key, { allowedChainIds: [8453] })` threw.
   - The swap succeeded (152k gas). The user received 2994 hUSDC, the collector received the fee, and the wrapper held 0 afterwards.
   - Re-sending the same signed transaction reverted with `NonceAlreadyUsed` (`0x1fb09b80`).
   - A route priced 10% under the oracle was refused with `below_oracle_value`.
   - The wrapper's `eip712Domain()` reported chain ID 31337.
2. **Fork under another chain ID works.** `anvil --fork-url <Base> --chain-id 31337`:
   - `eth_chainId` returns 31337 and the `chainid` opcode returns 31337 (a FeeWrapper deployed there reports 31337 in `eip712Domain()`);
   - forked contracts (Base USDC: `decimals() = 6`, `symbol() = USDC`) are readable.
3. **Fork mode is not deterministic without a paid archive RPC.**
   - Pinning `--fork-block-number` on a public endpoint failed: `403 Archive requests require a personal token`.
   - On that fork, anvil account 0 is a real Base address with nonce 3,440,671. `Deploy.s.sol` fell back to plain CREATE and landed at a different address (`0xafb8…0188` instead of `0x60a1…3859` on plain anvil).
   - `--dump-state` followed by `--load-state` without the fork kept our deployed contracts but **not** the forked state that was only read (USDC had no code after reload), so an offline fork snapshot does not work this way.

### Constraints found in the code

- `NEVER_LOCAL_CHAINS` (`apps/api/src/adapters/signers/local-key.ts`) is built from **every EVM chain in `CHAINS`** and **every chain in `TRUSTED_ROUTERS`**. Adding 31337 to either would deny the local key on it, and it would also blur the "registry = live chains" rule. The local chain must therefore live **outside** `CHAINS` and outside `TRUSTED_ROUTERS`.
- `POST /v1/quotes` does not need the chain to be in the registry (`quoteSchema` accepts any canonical `evm:<id>`), and `buildServer` already takes its providers, oracle, route policy and signer as dependencies. Only `GET /v1/chains`, `GET /v1/tokens`, balances and direct wraps read the registry directly.
- The web refuses a quote whose chain is not in its checked-in registry (ADR 0012), and wagmi's chains come from `CHAINS`.
- The web does **not** pin the wrapper address today; nothing in `apps/web` names it. The signing UI must add that pin (below).

## Decision

### 1. Default mode: plain anvil, chain 31337, mock contracts. Fork mode is an optional local extra.

| Mode                | Chain                                            | Liquidity                         | Secrets         | Deterministic            | CI                           |
| ------------------- | ------------------------------------------------ | --------------------------------- | --------------- | ------------------------ | ---------------------------- |
| **plain** (default) | `anvil --chain-id 31337`, empty genesis          | mock router at a fixed rate       | none            | yes                      | yes                          |
| fork (optional)     | `anvil --fork-url $URL@<block> --chain-id 31337` | real token contracts, mock router | archive RPC URL | only with an archive RPC | no (manual, owner's machine) |

Fork mode adds one thing that is worth having: real token behaviour (USDC proxy, USDT's approve-from-non-zero rule). It is not worth its cost as the default.

### 2. The local chain: `evm:31337`, local-only, outside the registry

- **Chain config.** A new subpath export `@ranvier/chains/local-dev` holds `LOCAL_DEV_CHAIN` (key `evm:31337`, name "Local test chain (not a real network)") and its token list: hUSDC (6 decimals), hWETH (18 decimals, a WETH9-style contract so the direct wrap path works), and the mock router addresses. All addresses are fixed CREATE2 results. It is deep-frozen like `CHAINS`. It is **not** re-exported from the package index, not in `CHAINS` and not in `TOKEN_LIST`.
- **API.** The registry lookups that `/v1/chains`, `/v1/tokens`, balances and wraps use go through a `ChainCatalog` passed to `buildServer`. Production `main.ts` passes the registry only. The harness entry passes the registry plus `LOCAL_DEV_CHAIN`. No production code path imports `local-dev`.
- **Web.** A harness build adds `LOCAL_DEV_CHAIN` to the wallet chains, the token list and the quote parser's registry (section 5).
- **The mainnet guards do not change:**
  - `LOCAL_SIGNER_DEFAULT_CHAINS` already contains 31337, so no allowlist grows;
  - `NEVER_LOCAL_CHAINS`, `mainnetRulesApply` and `canSignChain` are not edited;
  - no environment variable is added that could widen what a local key signs.
- **Tests that pin this (PR 3):**
  - `CHAINS`, `TOKEN_LIST`, `TRUSTED_ROUTERS` and `ZEROX_SETTLERS` contain no 31337;
  - every `LOCAL_DEV_CHAIN` ID is in `LOCAL_SIGNER_DEFAULT_CHAINS` and not in `NEVER_LOCAL_CHAINS`;
  - the package index does not export `local-dev`;
  - `apps/api/src/main.ts` and `apps/web` production modules have no import path to `local-dev` or `harness` (a dependency-graph test);
  - for every ID in `NEVER_LOCAL_CHAINS`, the local signer refuses, whatever `LOCAL_SIGNER_CHAIN_IDS` says (already true; the test is kept).

### 3. Liquidity: 0x-shaped mock router, harness provider, fixed oracle

- **Contracts** (`contracts/harness/`, outside `src/`, never deployed beyond anvil):
  - `MockAllowanceHolder` has the exact 0x `exec(operator, token, amount, target, data)` ABI. It pulls `amount` from the caller to `target`, or forwards the value for native input, then calls `target`.
  - `MockSettler` has the exact `execute((recipient, buyToken, minAmountOut), bytes[] actions, bytes32 zid)` ABI. It pays `buyToken` at a fixed rate set at deploy and reverts below `minAmountOut`.
  - `HarnessToken` is a mintable ERC-20 with chosen decimals. `HarnessWETH` is WETH9-style.
  - Extra pairs exist for negative tests: one rate 10% under the oracle, and one router path that reverts.
- **Why the 0x shape:** `vetRoute` runs **unchanged**: canonical calldata, `operator == target`, Settler allowlist, input token and amount, recipient, output token, minimum, value, slippage floor and oracle bound. No new `RouterKind` and no new vetting code goes into production. The harness route policy is `{ 31337: [{ kind: 'zerox-allowance-holder', address: MockAllowanceHolder, targets: [MockSettler] }] }`. It is built by the harness entry and never merged into `TRUSTED_ROUTERS`.
- **`HarnessQuoteProvider`** (`apps/api/src/harness/`) implements `QuoteProvider` for `evm:31337` only. It encodes the calldata above with `buyAmount` at the settler's rate, and `minBuyAmount = slippageFloor(...)`, as 0x does.
- **`FixedPriceOracle`** (harness only) implements `PriceOracle` with fixed prices for the local tokens only, for example ETH and hWETH at $3,000 and hUSDC at $1, as `usdE18` integers. Decimals come from `LOCAL_DEV_CHAIN.knownDecimals`. It throws for any other chain or token. The settler rates are derived from the same constants, so the oracle bound passes on the normal pairs and fails on the "under oracle" pair. `DefiLlamaPriceOracle` is untouched.
- **Rejected: replaying recorded 0x responses on a fork.**
  - The calldata binds the original taker (our wrapper address, which differs on a fork, see the evidence), the recipient and pool state at one block.
  - It needs the real AllowanceHolder and Settler allowlisted for 31337, and an archive RPC.
  - It would prove 0x's calldata once, not our flow repeatedly. Real 0x calldata stays covered by the recorded-fixture unit tests (ADR 0004) and by Base Sepolia, as far as 0x serves it.
- **Rejected: a Uniswap router on a fork.** It needs a new `RouterKind`, and so new production vetting code written only for tests, plus an archive RPC.

### 4. API harness entry and its startup guards

`apps/api/src/harness/main.ts` composes `buildServer` with the harness provider, the fixed oracle, the harness policy, `LocalKeySigner` and the catalog with the local chain. It is excluded from `tsconfig.build.json`, so it is not in `dist/` and not in the production image (a test checks `dist/`). It runs with `tsx`. It refuses to start unless **all** of these hold:

- `RANVIER_ENV === 'harness'` exactly, and `NODE_ENV` is not `production`;
- `ZEROX_CHAIN_IDS` is exactly `31337`, and neither `KMS_KEY_ID` nor `ZEROX_API_KEY` is set;
- `QUOTE_SIGNER_PRIVATE_KEY` is one of the published anvil development keys (a fixed list). A real testnet key is refused, so nobody points the harness at one;
- `HOST` is loopback, and `WEB_ORIGINS` contains only loopback origins;
- the RPC endpoint answers `eth_chainId == 31337` (the existing endpoint verification), and `FeeWrapper.feeSigner()` there equals the signer address. This is the startup check ADR 0005 plans, built here first for the harness.

Production `main.ts` never reads `RANVIER_ENV=harness`, and gains one guard of its own: it refuses to start with a published anvil key on **any** chain other than 31337. A public key on Base Sepolia would let anyone sign zero-fee quotes for that wrapper. `Deploy.s.sol` gets the matching guard: it refuses a published anvil address as `FEE_SIGNER` when `block.chainid != 31337`.

### 5. Web harness build

- `RANVIER_BUILD_PROFILE=harness` at `next build`:
  - `next.config.ts` bakes `RANVIER_BUILD_LOCAL_CHAIN=1` through `env`, as it already does for the API origin (ADR 0008). The chain list is `[...EVM_CHAINS, ...(process.env.RANVIER_BUILD_LOCAL_CHAIN === '1' ? [LOCAL_DEV_CHAIN] : [])]`. In a normal build the literal is empty and the branch is removed;
  - the build goes to `distDir: '.next-harness'`, so `.next/standalone`, the deployed artifact, can never be a harness build;
  - `next.config.ts` refuses the profile unless `NEXT_PUBLIC_API_URL` is a loopback origin;
  - every page shows a fixed "Local test chain, not real funds" banner.
- **Release guard.** CI's normal web build fails if `.next/` contains the local chain's key or name, any harness address, or `RANVIER_BUILD_LOCAL_CHAIN=1`. `check:headers` additionally asserts that the production build has no 31337 in its chain list.
- **Wrapper pin.** The signing UI (PR 8) bakes the wrapper address per chain at build time (`RANVIER_BUILD_FEE_WRAPPERS`, validated like the API origin) and refuses a `swap.transaction.to` that differs. The harness passes the deterministic local address. Production passes the real one once it is deployed. This pin gets its own short ADR with PR 8.

### 6. Test wallet: an EIP-6963 provider whose key stays in Node

The existing fixture (`tests/e2e/wallet-fixture.ts`) already announces fake EIP-6963 wallets and reports calls through a Playwright binding. The harness wallet extends that pattern:

- `addInitScript` announces one provider. Every `request()` goes through `page.exposeBinding` to the test process. **The key and the RPC connection stay in Node:**
  - viem signs with anvil account 2;
  - transactions go to anvil as `eth_sendRawTransaction`;
  - reads (`eth_call`, `eth_estimateGas`, `eth_getTransactionReceipt`, `eth_blockNumber`, `eth_getBalance`, `eth_getTransactionCount` and the fee methods) are proxied from an allowlist; anything else answers `4200`.
- **Consequence: the browser never connects to anvil, so `connect-src` is not changed, not even in the harness build.** This matches real extensions, whose RPC traffic does not go through the page's CSP. `csp.spec.ts` runs unchanged against the harness build.
- **Scenario controls** (test side only):
  - reject the next request (`4001`);
  - report a wrong chain (`0x1`), or answer `4902` on a switch;
  - low ETH (`anvil_setBalance`) for insufficient gas;
  - hold mining (`evm_setAutomine false`) to show pending, replacement (same nonce, higher fee) and dropped transactions;
  - an approval that is already set, or set too low;
  - the quote expiring before signing (`evm_increaseTime`).
- `ALLOWED_WALLET_METHODS` stays as it is for the existing suite. The harness suite has its own allowlist, which adds `eth_sendTransaction` and nothing else that signs (no `eth_sign`, `personal_sign` or `eth_signTypedData*`: the flow needs none).

### 7. Deployment, addresses and funding

- **Deploy order:**
  1. `script/harness/DeployHarness.s.sol` deploys the mocks with a fixed salt through the genesis CREATE2 factory.
  2. The unchanged `Deploy.s.sol` deploys the wrapper. Its environment: owner and guardian = anvil account 0, collector = account 3, `FEE_SIGNER` = account 1 (the API's local key), `INITIAL_ROUTERS` = `MockAllowanceHolder`.
- **Addresses** are the same on every plain run; the spike reproduced them. They are committed in `LOCAL_DEV_CHAIN`, and the deploy step fails if the deployed addresses differ, saying "mocks changed: update local-dev addresses". The wrapper address reaches:
  - the API as `FEE_WRAPPER_ADDRESS`;
  - the web build as its pin, from the same committed constant;
  - the runbook, so nothing is copied by hand.
- **Funding, plain mode:** `anvil_setBalance` for ETH, and the harness tokens' open `mint` (these are harness contracts, so an open mint is harmless). Fully deterministic.
- **Funding, fork mode:** forge-std `deal` from a script, which finds the balance slot and writes it. This is deterministic at a pinned block. Whale impersonation is not used: it depends on one address's balance at that block and breaks silently when the pin moves.

### 8. Orchestration

`pnpm harness:up`, `pnpm harness:down`, `pnpm harness:smoke` and `pnpm e2e:harness` run one Node script (`scripts/harness/`, run with `tsx`). It:

- refuses to start if any of its ports (anvil 8645, API 4310, web 3310, all on 127.0.0.1) is taken. It never frees a port it did not take, and never uses 3000;
- spawns each child itself and records the PIDs in `.harness/pids.json` (git-ignored);
- tears down by those exact PIDs only (SIGTERM, then SIGKILL after a timeout), with no `pkill` or name patterns;
- runs, in order: start anvil, assert `eth_chainId == 31337`, deploy and check addresses, fund, start the harness API, build and start the harness web, then (for `e2e:harness`) run Playwright with `playwright.harness.config.ts`, which reuses the started stack.

CI runs plain mode in a separate job with `foundry-rs/foundry-toolchain` pinned by commit SHA, using no secrets. Fork mode reads `HARNESS_FORK_URL` from the owner's shell and never runs in CI.

## What the harness proves, and what it does not

**Proves:**

- the web's real wagmi/viem path through an EIP-6963 provider: connect, chain check, approval (exact amount), `swap` call, waiting for the receipt, every rejection and failure state, pending and replaced transactions, an expired quote reverting on chain;
- the API's real quote, fee, `vetRoute`, signing and echo code (ADR 0012) on a chain where the local key may sign;
- the real `FeeWrapper` bytecode from `Deploy.s.sol`: signature, nonce, deadline, fee transfer, exact approvals, the minimum-output check;
- the guards: CSP unchanged, no harness code in production artifacts, no local key on any live chain.

**Does not prove**, and where each gap is closed:

| Gap                                                                                             | Closed by                                                                                                |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Real 0x calldata, AllowanceHolder transient allowances, Settler actions, real liquidity and gas | Base Sepolia (option a) as far as 0x serves it; recorded-fixture unit tests; mainnet canary after audits |
| DefiLlama prices and their failure modes                                                        | existing unit tests; Base Sepolia                                                                        |
| KMS signing                                                                                     | `kms:smoke` and the testnet KMS key (ADR 0005)                                                           |
| Mainnet chain behaviour (L2 fees, reorgs, real block times, real RPC failover)                  | Base Sepolia; production monitoring                                                                      |
| Real wallet UX: extension prompts, hardware wallets, Safari, mobile, WalletConnect              | manual test matrix before release                                                                        |
| Real-token quirks (USDT approve, proxies, blocklists)                                           | optional fork mode; Base Sepolia only partly                                                             |
| Contract security                                                                               | the two audits                                                                                           |

A green harness run means "our code does what we designed on a chain we control". It does not mean "ready for mainnet".

## Alternatives considered

- **Base Sepolia first.** Rejected for now by the owner: it needs a deploy, faucet funds and a live provider that 0x does not serve on testnet anyway. It stays option (a).
- **Fork as the default.** Rejected: it needs an archive RPC (a secret), its addresses are not deterministic, and it has no offline snapshot (evidence 3).
- **A fork reporting the real chain ID with a mainnet exception for the local key.** Rejected outright: any switch that lets a local key sign for 1, 8453 or 42161 is a production risk.
- **Adding 31337 to `CHAINS` or `TRUSTED_ROUTERS`.** Rejected: it would deny the local key on it through `NEVER_LOCAL_CHAINS`, list a fake chain in production `/v1/chains`, and need exceptions in the guards.
- **A wallet that calls anvil from the page.** Rejected: it needs `connect-src` to include the anvil RPC in some build, which is exactly the CSP change ADR 0008 forbids.

## Consequences

- One small production refactor (`ChainCatalog` injection) and two new production guards (no anvil key off 31337, in the API and in `Deploy.s.sol`). Everything else is harness-only code that production entry points cannot import.
- The harness tokens and mock router are part of the repo and need maintenance when the 0x calldata shape changes. `vetRoute` would then fail in the harness first, which is the desired signal.
- CI gains a Foundry toolchain and a job of a few minutes.
- Mock contract changes move the CREATE2 addresses. The committed constants must be updated in the same PR, and the deploy check enforces it.

## Work breakdown (dependency order)

"SR" means the security reviewer must approve the PR before it is called done.

| #   | PR                                                                                                                                                                                | Owner                         | Size | SR  | Unblocks |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---- | --- | -------- |
| 1   | Harness mocks in `contracts/harness/`, `DeployHarness.s.sol`, a forge `HarnessSmoke.s.sol` (approve + swap with `vm.sign`) on plain anvil, and the `Deploy.s.sol` anvil-key guard | contract-engineer             | S    | yes | 2 to 8   |
| 2   | `scripts/harness/smoke.ts`: the ADR spike made permanent; the real `vetRoute` + `LocalKeySigner` + `buildSignedSwap`, then approve, swap, replay revert and oracle refusal        | routing-engineer, test-writer | S    | yes | 4        |
| 3   | `@ranvier/chains/local-dev` (`LOCAL_DEV_CHAIN`, tokens, addresses) and the guard tests in section 2                                                                               | architect, routing-engineer   | S    | yes | 4, 6     |
| 4   | API: `ChainCatalog` injection, `apps/api/src/harness/` (provider, fixed oracle, policy, entry, startup guards), the `dist/` exclusion test, the production anvil-key guard        | routing-engineer              | M    | yes | 5        |
| 5   | Orchestrator: `harness:up/down/smoke`, PID file, port checks, CI job                                                                                                              | chore-runner, test-writer     | M    | yes | 7        |
| 6   | Web harness build profile: baked flag, `.next-harness`, banner, loopback guard, release-bundle check                                                                              | ui-builder                    | S    | yes | 7, 8     |
| 7   | Node-side EIP-6963 anvil wallet, `playwright.harness.config.ts`, a first connect-and-quote test on 31337                                                                          | test-writer                   | M    | yes | 8        |
| 8   | Signing UI, in slices: wrapper pin (own ADR), review screen, approval, swap, simulation, confirmation and receipt; each slice ships with its harness e2e tests                    | ui-builder, routing-engineer  | L    | yes | —        |
| 9   | Optional fork mode (`--fork`, `deal` funding, USDT approve test)                                                                                                                  | test-writer                   | S    | no  | —        |

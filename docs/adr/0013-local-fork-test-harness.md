# ADR 0013: Local chain test harness for signing and sending

- Status: accepted as the plan of record (design only; nothing here is built yet)
- Date: 2026-10-15

## Context

The web signing flow (review, ERC-20 approval, FeeWrapper swap, simulation, confirmation) cannot run end to end today:

- 0x does not quote testnets or local chains.
- `LocalKeySigner` refuses every mainnet (ADR 0004), and mainnet signing needs a KMS key (ADR 0005) and two audits.
- The wrapper is not deployed on Base Sepolia.

The owner chose a **local harness first**: the whole flow on a local chain, with no live testnet and no secrets. Base Sepolia (option a) comes later.

### Evidence (spikes on 2026-10-15, anvil/forge 1.8.3; nothing committed but this ADR and the runbook)

1. **Plain anvil, unchanged production code, real swap.**
   - Setup: `anvil --chain-id 31337`, which has the Arachnid CREATE2 factory `0x4e59…956c` at genesis. Mock tokens, a mock AllowanceHolder and a mock Settler were deployed with a fixed salt. `contracts/script/Deploy.s.sol` ran **unchanged**.
   - A TypeScript script then called the API's own `quoteFee`, `vetRoute` (with an injected 31337 policy), `LocalKeySigner`, `canSignChain` and `buildSignedSwap`, and sent approve and `swap` with viem.
   - Results:
     - `vetRoute` passed: fee 20 bps, signed minimum 2979.03 hUSDC.
     - `canSignChain(31337)` was true and `canSignChain(8453)` was false; a `LocalKeySigner` allowed for `[8453]` threw.
     - The swap succeeded. The user received 2994 hUSDC, the collector received the fee, and the wrapper held 0 afterwards.
     - Sending the same transaction again reverted with `NonceAlreadyUsed` (`0x1fb09b80`).
     - A route priced 10% under the oracle was refused with `below_oracle_value`.
     - The wrapper's `eip712Domain()` reported chain ID 31337.
2. **A fork under another chain ID works.** `anvil --fork-url <Base> --chain-id 31337` reports 31337 through both `eth_chainId` and the `chainid` opcode, and Base USDC was readable.
3. **A fork is not deterministic without a paid archive RPC.**
   - A pinned block on a public endpoint got `403 Archive requests require a personal token`.
   - Anvil account 0 has a real nonce on Base (3,440,671), so the wrapper landed at a different address.
   - `--dump-state` followed by `--load-state` lost the forked state that had only been read.

### Constraints found in the code

- `NEVER_LOCAL_CHAINS` (`apps/api/src/adapters/signers/local-key.ts`) includes every EVM chain in `CHAINS` and every chain in `TRUSTED_ROUTERS`. The local chain must therefore stay out of both.
- 31337 is already in `LOCAL_SIGNER_DEFAULT_CHAINS` (`apps/api/src/mainnet-rules.ts:14`), so the harness widens no allowlist.
- `POST /v1/quotes` accepts any canonical `evm:<id>`. `buildServer` already takes its providers, oracle, route policy and signer as inputs. Only the chain and token lists, balances and direct wraps read the registry directly.
- The web refuses a quote whose chain is not in its registry (ADR 0012), and wagmi's chains come from `CHAINS`.
- The web does not pin the wrapper address today.

## Decision

### 1. Plain anvil only (chain 31337, mock contracts); fork mode deferred

The harness runs `anvil --chain-id 31337` from an empty genesis, with mock contracts. It needs no secrets, gives the same result every run, and runs in CI.

Fork mode is **deferred** (owner decision). It would add real token behaviour, but it needs an archive RPC (a secret) and is not deterministic (evidence 3). The token quirks it would catch are covered by mock tokens instead (section 3).

### 2. The local chain stays outside the registry

- **Chain config.** `@ranvier/chains/local-dev` exports `LOCAL_DEV_CHAIN`: key `evm:31337`, name "Local test chain (not a real network)", tokens hUSDC (6 decimals) and hWETH (WETH9-style), and the mock addresses, all fixed CREATE2 results. It is deep-frozen, not re-exported from the package index, and not in `CHAINS` or `TOKEN_LIST`.
- **API.** The registry lookups go through a `ChainCatalog` passed to `buildServer`. Production `main.ts` passes the registry only.
- **Unchanged:** `NEVER_LOCAL_CHAINS`, `mainnetRulesApply`, `canSignChain` and `LOCAL_SIGNER_DEFAULT_CHAINS`. No environment variable is added that could widen what a local key signs.
- **Tests (PR 3):**
  - `CHAINS`, `TOKEN_LIST`, `TRUSTED_ROUTERS` and `ZEROX_SETTLERS` contain no 31337;
  - `LOCAL_DEV_CHAIN` is in `LOCAL_SIGNER_DEFAULT_CHAINS` and not in `NEVER_LOCAL_CHAINS`;
  - the package index does not export `local-dev`;
  - an import-graph test shows that production `main.ts` and the production web modules reach neither `local-dev` nor `harness`.

### 3. Liquidity: 0x-shaped mocks that can fail

The mocks live in `contracts/harness/` (not `src/`) and are only ever deployed on anvil.

**Router mocks.**

- `MockAllowanceHolder` and `MockSettler` have **exactly** the 0x ABIs: `exec(operator, token, amount, target, data)` and `execute((recipient, buyToken, minAmountOut), bytes[] actions, bytes32 zid)`. Because the calldata is ABI-identical, `vetRoute` runs unchanged and still bites, and production gets no new `RouterKind`.
- The holder pulls the input with `transferFrom(wrapper → target)` **as the holder**, so an approval to the wrong spender fails.
- The Settler does **not** check `minAmountOut` itself. The wrapper's own `InsufficientOutput` check must be the guard that fires.
- The harness route policy, `{31337: [{kind: 'zerox-allowance-holder', address: MockAllowanceHolder, targets: [MockSettler]}]}`, is built only by the harness entry.
- Each pair selects one behaviour:

| Behaviour                                                              | Proves                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| pays at the fixed rate                                                 | happy path                                          |
| (a) underpays without reverting                                        | wrapper `InsufficientOutput`                        |
| (b) pays the wrapper instead of the user                               | the `outHeld` refund to the user                    |
| (c) holder spends less than `amount`                                   | the `inLeft` refund and the approval reset to 0     |
| (d) pulls from the wrapper as the holder                               | approval to the right spender only                  |
| (e) native input: requires `msg.value == amount` and forwards it       | the native value path                               |
| (f) reverts with return data; reverts with a very large return payload | revert bubbling, and gas behaviour on a huge revert |
| (g) re-enters `wrapper.swap`                                           | `nonReentrant`                                      |
| rate 10% under the oracle                                              | `vetRoute` `below_oracle_value` (never signed)      |

**Token mocks.**

- `HarnessToken`: mintable, with chosen decimals.
- USDT-style: no return value, and approve from non-zero reverts. Proves `forceApprove`.
- A token whose transfers return `false`.
- A fee-on-transfer token. The wrapper must revert `UnsupportedToken`.
- An ERC-777-style token with a hook that calls back.

**`HarnessQuoteProvider`** (`apps/api/src/harness/`) quotes `evm:31337` only. It encodes the 0x-shaped calldata with `minBuyAmount = slippageFloor(...)`.

**`FixedPriceOracle`** prices the local tokens only (ETH and hWETH at $3,000, hUSDC at $1, as `usdE18` integers) and throws for anything else. The settler rates are derived from the same constants. `DefiLlamaPriceOracle` is untouched.

**Rejected:**

- replaying recorded 0x responses on a fork: they bind the original taker, recipient and block, and need an archive RPC;
- a Uniswap router: it needs a new `RouterKind`, so new production vetting code.

### 4. API guards (match by address; loopback only)

Production code holds **addresses only**, never keys: the first 20 accounts of the published `test test … junk` mnemonic.

**Production `main.ts`** (PR 1 or PR 4, with SR review):

- It derives the local signer's address and refuses to start with a published development address when any quoted chain is not 31337.
- It applies the same check to `KMS_EXPECTED_SIGNER_ADDRESS`. A published key imported as external KMS key material is still public.

**Harness entry `apps/api/src/harness/main.ts`.** It is excluded from `tsconfig.build.json`, a test checks that `dist/` contains none of it, and it runs with `tsx`. It refuses to start unless **all** of these hold:

- `RANVIER_ENV === 'harness'` and `NODE_ENV` is not `production`;
- `ZEROX_CHAIN_IDS` is exactly `31337`, and neither `KMS_KEY_ID` nor `ZEROX_API_KEY` is set;
- the signer is a published development key, constructed with `allowedChainIds: [31337]`, **not** the default list that includes three testnets;
- every RPC URL is `http://127.0.0.1:<port>` or `http://[::1]:<port>`. Anything else is refused even if it answers `eth_chainId` 31337, because 31337 is not reserved and public chains have used it;
- no `RPC_URLS_EVM_*` variable is set for any chain but 31337 (a shell can leak one in);
- `HOST` and `WEB_ORIGINS` are loopback;
- the endpoint answers `eth_chainId == 31337`, and `FeeWrapper.feeSigner()` equals the signer address.

### 5. Web harness build and the wrapper pin

**Harness profile.** `RANVIER_BUILD_PROFILE=harness` at `next build` does the following.

- A **bundler alias** points `@ranvier/chains/local-dev` at the real module only under this profile. In every other build it resolves to an empty stub. A flag in a spread expression would not be enough: `@ranvier/chains` has no `sideEffects: false` and deep-freezes at module top level, so the static import would survive tree shaking.
- The output goes to `distDir: '.next-harness'`, never to `.next/standalone`.
- The build is refused unless `NEXT_PUBLIC_API_URL` is loopback.
- At runtime, a harness build refuses to render unless `location.hostname` is loopback, and it shows a "Local test chain, not real funds" banner.

**Release gate (mandatory CI).** The normal build fails if `.next/` contains the local chain's key or name, any harness address, or the profile flag.

**Wrapper pin (decided; its own short ADR comes with the signing UI).**

- The build bakes a wrapper address per chain.
- A malformed or zero address fails the build.
- A chain with no pin cannot be signed for.
- A quote whose `swap.transaction.to` differs from the pin is refused.
- The page builds the transaction itself and never takes `to`, `data` or `value` from wallet-supplied data.

### 6. Reads through the wallet provider (decided), and what is never trusted

Receipts and simulation go through the wallet provider: a wagmi transport over EIP-1193 `custom(window.ethereum)` for reads. There is no new API endpoint, and the CSP is unchanged. Nothing a wallet returns is trusted for a decision:

- **Simulation** is display only. The wrapper's on-chain checks are the guard.
- **Receipt status and logs** are shown as "confirmed according to your wallet". No amount is credited from them.
- **`eth_chainId`** is compared with the quote's `chainId` before sending. The real guard is the transaction's own EIP-155 chain ID.
- **Balances and gas estimates** never decide anything. A balance below the swap amount **warns** on the review screen and never blocks, and the warning says the balance can be out of date.

### 7. Test wallet: EIP-6963 in the page, key and RPC in Node

- An `addInitScript` provider announces one wallet over EIP-6963 and forwards every `request()` through `page.exposeBinding`.
- In the test process, viem signs with anvil account 2 and talks to anvil. Read methods come from an allowlist (`eth_call`, `eth_estimateGas`, `eth_getTransactionReceipt`, `eth_blockNumber`, `eth_getBalance`, `eth_getTransactionCount`, fee methods). Anything else answers `4200`.
- **The browser never connects to anvil, so `connect-src` is unchanged in every build.**
- The harness suite's method allowlist adds only `eth_sendTransaction`. No `eth_sign`, `personal_sign` or `eth_signTypedData*` is allowed.
- **The wallet enforces and records, and every swap test asserts:**
  - `to` is the pinned wrapper, or the exact token being approved;
  - for an approval, `spender == wrapper` and the amount is exact;
  - `chainId` is 31337;
  - `value` equals `amountIn` for a native sale and is 0 otherwise.
- **Scenarios (PRs 7 and 8):**
  - the user rejects (`4001`);
  - an unknown chain on switch (`4902`);
  - the wallet is on the wrong chain at send time;
  - not enough ETH for gas;
  - pending and replaced transactions (`evm_setAutomine false`);
  - a dropped or reorged transaction (`anvil_reorg`, `anvil_rollback`);
  - an allowance already set, too low, or left over after a failed swap;
  - expiry through `evm_increaseTime`;
  - a replayed nonce;
  - the wrapper paused;
  - the router removed from the allowlist between quote and send;
  - `feeSigner` rotated, so the API startup check fails.

### 8. Deployment, the deploy guard, funding and keys

**Deploy order.**

1. `DeployHarness.s.sol` deploys the mocks with a fixed salt.
2. The orchestrator **asserts the RPC is loopback before any `forge script`**, because Solidity cannot see `--rpc-url`.
3. `Deploy.s.sol` deploys the wrapper:
   - owner and guardian are account 0;
   - the collector is account 3;
   - `FEE_SIGNER` is account 1;
   - `INITIAL_ROUTERS` is `MockAllowanceHolder`.
4. The deployed addresses must equal the constants committed in `LOCAL_DEV_CHAIN`, or the run stops. From there they reach the API (`FEE_WRAPPER_ADDRESS`) and the web pin.

**Deploy guard (PR 1, SR review).** `Deploy.s.sol` gets a `require` before broadcast. `FeeWrapper` is not changed. When `block.chainid != 31337`, the script refuses if any of `ADMIN_ADDRESS`, `GUARDIAN_ADDRESS`, `FEE_COLLECTOR`, `FEE_SIGNER` or an `INITIAL_ROUTERS` entry is one of these addresses:

- the first 20 accounts of the published mnemonic;
- `address(0)`, `0x…01` or `0x…02`;
- the anvil CREATE2 deployer.

On chains 1, 8453 and 42161 it refuses any `INITIAL_ROUTERS` at all. There is one forge test per refused role.

Hardened after the PR 1 security review: the published list also covers every address up to `0x…01ff`, forge's default sender and test contract, the `0x…dEaD` and `0xdEAD…2069` burn addresses and mnemonic accounts 20-29. The three-chain rule became an allowlist: `INITIAL_ROUTERS` may be non-empty only on 84532, 11155111, 421614 and 31337 (`LOCAL_SIGNER_DEFAULT_CHAINS`). A malformed `INITIAL_ROUTERS` reverts, duplicates are refused, a router may not also hold a role, and forge-std's `DEFAULT_TEST_CONTRACT` is listed. The wrapper is now created by an explicit call to the CREATE2 factory instead of `new FeeWrapper{salt: ...}`, because forge's OP-stack mode broadcast the latter as a plain `CREATE` at a nonce address (see the testnet runbook); the address, bytecode and state are unchanged wherever the old script already used CREATE2.

**Funding.** `anvil_setBalance` for ETH, and the harness tokens' open `mint`. Both are deterministic.

**Keys and gitleaks.**

- Harness keys live only in harness and test code, each labelled "PUBLIC anvil key, chain 31337 only".
- They are either derived at runtime from the published mnemonic, or allowlisted **by exact value** in `.gitleaks.toml`, never by path.
- The runbook uses `--unlocked --sender`, so no key is written anywhere.

### 9. Orchestration and CI

`pnpm harness:up`, `harness:down`, `harness:smoke` and `e2e:harness` are one `tsx` script. It:

- refuses ports already in use (anvil 8645, API 4310, web 3310, all on 127.0.0.1). It never uses 3000 and never stops a process it did not start;
- records the PIDs of the children it spawns in `.harness/pids.json`;
- tears down by those exact PIDs only.

CI runs the harness in its own job with no secrets, using `foundry-rs/foundry-toolchain@v1`. That action is pinned by **tag**, like every other action in the workflows today. A separate chore PR is recommended to pin every action by commit SHA and to verify the gitleaks tarball's checksum (today it is `curl | tar` with no check).

## What the harness proves, and what it does not

**It proves:**

- the real wagmi and viem path through an EIP-6963 provider, including every rejection, chain, pending and failure state above;
- the API's real fee, `vetRoute`, signing and echo code on a chain a local key may sign for;
- the real `FeeWrapper` bytecode: signature, nonce, deadline, fee, exact approvals and their reset, refunds, minimum output, reentrancy, unsupported tokens;
- the guards: CSP unchanged, no harness code in production artifacts, no published address in any real-chain role.

**It does not prove the following.** A green run means "our code does what we designed, on a chain we control". It does not mean "ready for mainnet".

| Gap                                                                                                     | Closed by                                                        |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Real 0x calldata and Settler action encoding (the mocks are ABI-identical only), real liquidity and gas | Base Sepolia as far as 0x serves it; recorded-fixture unit tests |
| Real AllowanceHolder transient allowances, and its confused-deputy target checks                        | 0x's own audits; Base Sepolia; mainnet canary after audits       |
| DefiLlama prices, KMS signing                                                                           | unit tests; `kms:smoke` with the testnet key (ADR 0005)          |
| Mainnet chain behaviour (L2 fees, real reorgs, block times, RPC failover)                               | Base Sepolia; production monitoring                              |
| Real wallet UX: extension prompts, hardware wallets, Safari, mobile, WalletConnect                      | manual test matrix before release                                |
| Real tokens (USDC proxy, blocklists), beyond the mock quirks                                            | Base Sepolia (partly); fork mode if it is ever revived           |
| Contract security                                                                                       | the two audits                                                   |

## Alternatives considered

- **Base Sepolia first.** Deferred by the owner; it stays option (a).
- **Fork as the default.** Rejected: secret, not deterministic, no offline snapshot (evidence 3).
- **A fork under its real chain ID with a local-key exception.** Rejected: any switch that lets a local key sign for 1, 8453 or 42161 is a production risk.
- **31337 in `CHAINS` or `TRUSTED_ROUTERS`.** Rejected: it would deny the local key through `NEVER_LOCAL_CHAINS` and list a fake chain in production.
- **A wallet that calls anvil from the page.** Rejected: it would need `connect-src` widened, which ADR 0008 forbids.

## Consequences

- **Production changes:** one refactor (`ChainCatalog`) and three guards (the published-address check in `main.ts`, the published-address check on the KMS expected address, and the `Deploy.s.sol` role check). Everything else is harness-only code that production entry points cannot reach.
- **Maintenance:** the mocks must follow the 0x ABIs. If the ABIs change, `vetRoute` fails in the harness first.
- **Addresses:** changing a mock moves its CREATE2 address. The committed constants are updated in the same PR, and the deploy check enforces it.

## Work breakdown (dependency order; SR = security-reviewer must approve)

PR 1 status (2026-10-15): built on `feat/harness-mock-contracts`. The mocks live in `contracts/test/harness/` rather than `contracts/harness/`, so Slither and coverage skip them. A local `forge build` still compiles them into `out/`; that is harmless, because `Deploy.s.sol`'s metadata imports only `FeeWrapper` and nothing publishes `out/`; addresses are in the [runbook](../runbooks/local-harness.md).

PR 2 status (2026-10-16): built on `feat/harness-ts-smoke`. The smoke lives in `apps/api/scripts/harness/` (not a root `scripts/` folder) so it imports the API's modules directly and reuses the API's `tsx`, `tsconfig.scripts.json` and lint; the API build compiles `src/` only. `pnpm harness:smoke` starts and stops its own anvil; commands are in the [runbook](../runbooks/local-harness.md).

| #   | PR                                                                                                                                                                           | Owner                         | Size | SR  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---- | --- |
| 1   | Harness mocks (section 3) with forge tests; `DeployHarness.s.sol`; forge `HarnessSmoke.s.sol` (approve and swap on plain anvil); the `Deploy.s.sol` role guard and its tests | contract-engineer             | M    | yes |
| 2   | `scripts/harness/smoke.ts`: the spike made permanent (real `vetRoute`, `LocalKeySigner`, `buildSignedSwap`, swap, replay, oracle refusal)                                    | routing-engineer, test-writer | S    | yes |
| 3   | `@ranvier/chains/local-dev` and the guard tests in section 2                                                                                                                 | architect, routing-engineer   | S    | yes |
| 4   | API: `ChainCatalog`, `apps/api/src/harness/` with the section 4 guards, `dist/` exclusion test, production published-address guard                                           | routing-engineer              | M    | yes |
| 5   | Production `feeSigner()` startup check on every real signing chain (ADR 0005)                                                                                                | routing-engineer              | S    | yes |
| 6   | Orchestrator (`harness:*`, PID file, port and loopback checks), CI job, gitleaks exact-value allowlist                                                                       | chore-runner, test-writer     | M    | yes |
| 7   | Web harness profile: alias stub, `.next-harness`, loopback guards, banner, release gate                                                                                      | ui-builder                    | S    | yes |
| 8   | Node-side anvil wallet with its enforcement, `playwright.harness.config.ts`, first connect-and-quote test                                                                    | test-writer                   | M    | yes |
| 9   | Signing UI in slices: wrapper-pin ADR, review screen, approval, swap, wallet-provider reads, confirmation; the negative scenarios in section 7                               | ui-builder, routing-engineer  | L    | yes |
| 10  | Chore: pin every GitHub Action by commit SHA; verify the gitleaks tarball's checksum                                                                                         | chore-runner                  | S    | yes |

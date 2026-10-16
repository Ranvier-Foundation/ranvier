# Runbook: local chain test harness

Design: [ADR 0013](../adr/0013-local-fork-test-harness.md). Sections marked **(planned)** describe commands that do not exist yet. Built so far:

- the mock contracts, `DeployHarness.s.sol`, the forge smoke script and the `Deploy.s.sol` role guard (PR 1);
- the TypeScript smoke (PR 2);
- `@ranvier/chains/local-dev` with its guard tests (PR 3);
- the production signer guards (PR 4a) and the harness API, `pnpm harness:api` (PR 4b).

Nothing here uses real funds, a live network or a secret.

## Rules

- **Chain ID 31337, loopback only.** Start anvil with `--chain-id 31337 --host 127.0.0.1`. Every RPC URL the harness uses must be `http://127.0.0.1:<port>` or `http://[::1]:<port>`. 31337 is not reserved, so an endpoint answering 31337 elsewhere is refused all the same.
- **Published development accounts only.** Accounts come from anvil's published mnemonic (`test test test test test test test test test test test junk`). They are public, worthless and allowed only on 31337.
  - Never use them on a testnet or mainnet: off 31337, `Deploy.s.sol` refuses them in every role and as an initial router, before anything is broadcast (`PublishedDevAddress(role, account)`). It also refuses every address up to `0x…01ff`, the CREATE2 factory, forge's default sender and test contract and the burn addresses, and any `INITIAL_ROUTERS` outside 84532, 11155111, 421614 and 31337 (`InitialRoutersRefused`).
  - Never put any other key into the harness.
  - Commands below use `--unlocked --sender <address>`, so no key is typed or stored.
- **Ports.** Anvil 8645, API 4310, web 3310, all on 127.0.0.1. **Never use or stop port 3000** (the owner's dev server). The harness only stops processes it started.
- **No `.env`.** The harness needs no `.env` file. Do not print or copy one.
  - Do not keep a `contracts/.env` at all: forge loads it automatically for every `forge script`, including the one `pnpm harness:smoke` runs, so a stray value (a role address, `INITIAL_ROUTERS`, an RPC or key variable) silently changes the deploy.
  - The forge child that `pnpm harness:smoke` starts also loads your global Foundry config (`~/.foundry/foundry.toml`) next to `contracts/foundry.toml`. Keep profile overrides out of it, or expect them to apply to the harness too.

| Role                       | Anvil account | Address                                      |
| -------------------------- | ------------- | -------------------------------------------- |
| deployer, owner, guardian  | 0             | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| fee signer (API local key) | 1             | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| test user (browser wallet) | 2             | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| fee collector              | 3             | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |

Foundry is not on `PATH` by default: `export PATH="$HOME/.foundry/bin:$PATH"`.

## One command (planned)

```sh
pnpm harness:up       # anvil, deploy, fund, API, web; prints the URLs
pnpm harness:smoke    # approve + swap from a script, no browser
pnpm e2e:harness      # Playwright signing suite against the running stack
pnpm harness:down     # stops exactly the PIDs in .harness/pids.json
```

`harness:up` refuses to start if one of its ports is already in use. It never kills a process by name or pattern. In order, it:

1. starts anvil, then checks that the RPC URL is loopback and that `eth_chainId` is 31337. Both checks run before any `forge script`;
2. runs `DeployHarness.s.sol`: the mocks, then the wrapper through `Deploy.s.sol`'s own code path with the mock AllowanceHolder as its only router;
3. checks the deployed addresses against `@ranvier/chains/local-dev`, and stops with "mocks changed: update local-dev addresses" if they differ;
4. funds account 2 with `anvil_setBalance` and the harness tokens' `mint`;
5. starts the harness API (`pnpm harness:api`, built: see "Harness API" below). The API checks `feeSigner()` on chain before it listens;
6. builds the web with `RANVIER_BUILD_PROFILE=harness` into `.next-harness` and serves it on 3310.

## Mock contracts (built)

Everything harness-only lives in `contracts/test/harness/`. Nothing under `test/` is part of a production artifact: `src/` and `script/Deploy.s.sol` import none of it, and Slither and coverage skip `test/`. Never move it to `src/` or `script/`.

| File                            | What it is                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `ZeroXMocks.sol`                | `MockAllowanceHolder` (`exec`, 0x2213bc0b) and `MockSettler` (`execute`, 0x1fff991f), 0x ABIs |
| `HarnessTokens.sol`             | hUSDC, hWETH and the quirk tokens; every token has an open `mint`                             |
| `HarnessConfig.sol`             | salts, the address table below, the harness accounts (addresses only)                         |
| `DeployHarness.s.sol`           | chain 31337 only: mocks, then the real `FeeWrapper` through `Deploy.s.sol`'s path             |
| `HarnessSmoke.s.sol`            | approve and swap as account 2, quote signed in the script; `check()` re-reads the chain       |
| `*.t.sol`, `HarnessFixture.sol` | forge tests: each mock behaviour, and the real `FeeWrapper` reacting to each                  |

How the mocks behave:

- The wrapper calls the holder's `exec`. The holder gives the operator a one-call allowance and calls the Settler with the wrapper's address appended, as 0x does. The Settler pulls the input through `holder.transferFrom`, which runs `transferFrom(wrapper → settler)` **as the holder**, so only an approval to the holder works.
- For native input, the holder requires `msg.value == amount` and forwards it.
- The Settler never checks `minAmountOut`. The wrapper's `InsufficientOutput` is the guard.
- Its pair table is fixed in the constructor, so nobody can change a pair later. Pair keys use 0x's encoding: the zero address for native input, `0xeeee…eeee` for native output. ERC-20 output is minted to the payee. Native output comes from the Settler's balance; `DeployHarness` gives it 100 ETH.
- `actions` and `zid` are ignored. The mocks do not reproduce 0x's actions, its confused-deputy checks or real transient-allowance rules (ADR 0013, "What the harness proves").

Pairs (rates from ETH and hWETH at $3,000, every other harness token at $1, all 6 decimals except hWETH):

| Sell → buy                              | Behaviour                                      | What the wrapper must do                                         |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| ETH → hUSDC, hUSDC → ETH, hUSDC ↔ hWETH | pays at the fixed rate                         | happy path                                                       |
| hUSDT → hUSDC, hUSDC → hUSDT            | pays 1:1                                       | `forceApprove` and no-return transfers                           |
| hFALSE → hUSDC                          | pays 1:1                                       | refuse: `SafeERC20FailedOperation`                               |
| hTAX → hUSDC                            | pays 1:1                                       | refuse: `UnsupportedToken`                                       |
| hHOOK → hUSDC                           | pays 1:1                                       | a send hook that re-enters is blocked                            |
| hUSDC → hUNDER (a)                      | pays `minAmountOut - 1`, does not revert       | `InsufficientOutput`                                             |
| hUSDC → hPAYWRAP (b)                    | pays the wrapper instead of the user           | forward it to the user (`outHeld`)                               |
| hUSDC → hSPEND, ETH → hSPEND (c)        | spends half of `amount`                        | refund the rest (`inLeft`), approval back to 0                   |
| hUSDC → hREVERT (f)                     | reverts `MockSettlerFailed(sell, buy, amount)` | bubble the revert data unchanged                                 |
| hUSDC → hBIGREV (f)                     | reverts with a 1 MiB payload                   | bubble it whole (about 13.6M gas in total)                       |
| hUSDC → hREENTER (g)                    | calls `wrapper.swap` again                     | `ReentrancyGuardReentrantCall`                                   |
| hUSDC → hORACLE                         | pays 90% of the fair rate                      | executes; `vetRoute` must refuse it first (`below_oracle_value`) |

### Address table (fresh anvil, chain 31337)

CREATE2 through the factory at `0x4e59b44847b379578588920cA78FbF26c0B4956C`. The mock addresses depend only on the salt and the init code, not on who deploys. `HarnessConfig.t.sol` recomputes them, and `DeployHarness` stops with `MockAddressChanged` if a deployed address differs. Changing a mock moves its address: update `HarnessConfig.sol`, this table and `packages/chains/src/local-dev.ts` in the same PR (`pinned.test.ts` fails until all three agree).

| Contract            | Salt (bytes32 string)             | Address                                      |
| ------------------- | --------------------------------- | -------------------------------------------- |
| MockAllowanceHolder | `ranvier.harness.allowanceHolder` | `0xC0b06d1E9E0bb6e4b5d903A2b5afc57e1bF41Ce2` |
| MockSettler         | `ranvier.harness.settler`         | `0x2c7959766740C57e7615b9452FDe5E7273Bb6E3c` |
| hUSDC (6)           | `ranvier.harness.hUSDC`           | `0x5784F90419222088aC18AE5B62ef381f4Cb2deB1` |
| hWETH (18)          | `ranvier.harness.hWETH`           | `0x47FA559bE608137ea4D28588b6c57D0D1aC6552D` |
| hUSDT (USDT-style)  | `ranvier.harness.hUSDT`           | `0x591C8458edF8fD663317FD0D9F712B304829f996` |
| hFALSE              | `ranvier.harness.hFALSE`          | `0x76faf45C3E69F33E64FD1448A18cDe535a80b3c7` |
| hTAX                | `ranvier.harness.hTAX`            | `0x60bD9A310DF2ad9dfBC230ebf0aE49c35f547229` |
| hHOOK               | `ranvier.harness.hHOOK`           | `0x3f7E44dc6b1F3465c2e453BF5B37DDF2403c3DEC` |
| hUNDER              | `ranvier.harness.hUNDER`          | `0x3d186379d8AfB89332aA0b11CFD399d4966Eb917` |
| hPAYWRAP            | `ranvier.harness.hPAYWRAP`        | `0x2412e0EcE709981e91b3a54cf44a5558162e36de` |
| hSPEND              | `ranvier.harness.hSPEND`          | `0x00f68444Cd6325033d2B51CB61A0De7e781413D1` |
| hREVERT             | `ranvier.harness.hREVERT`         | `0x6a30B9fFa7B7353699D1B8F309554A979018a3e4` |
| hBIGREV             | `ranvier.harness.hBIGREV`         | `0x8114705c3eb8885ce22D5F14590788992F136668` |
| hREENTER            | `ranvier.harness.hREENTER`        | `0xa6673ad0094B3C28E672a9E1e28F03dbcBe7Cfb5` |
| hORACLE             | `ranvier.harness.hORACLE`         | `0xa03B74d8a5289B2A6278554183cE5d51dEb12c09` |
| FeeWrapper          | `0x…52414e56` ("RANV")            | `0x60A10abb52c31ec38f1f93c70B64D2Fb00913859` |

The wrapper address also depends on its roles: it holds for the roles in the commands below.

## Manual steps (work today)

No key is typed or stored: deploys use `--unlocked --sender`, and the smoke script derives the fee signer key (anvil account 1, a PUBLIC anvil key, chain 31337 only) in memory from the published mnemonic.

```sh
export PATH="$HOME/.foundry/bin:$PATH"
anvil --host 127.0.0.1 --port 8645 --chain-id 31337 --silent &
echo $! > /tmp/ranvier-anvil.pid           # later: kill "$(cat /tmp/ranvier-anvil.pid)"
cast chain-id --rpc-url http://127.0.0.1:8645   # must print 31337

cd contracts
export FEE_WRAPPER_SALT=0x0000000000000000000000000000000000000000000000000000000052414e56
export ADMIN_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 GUARDIAN_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
export FEE_COLLECTOR=0x90F79bf6EB2c4f870365E785982E1f101E93b906 FEE_SIGNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
unset INITIAL_ROUTERS                      # DeployHarness allowlists the mock holder itself

# 1. Mocks and the real wrapper (account 0 deploys)
forge script test/harness/DeployHarness.s.sol --rpc-url http://127.0.0.1:8645 --broadcast \
  --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# 2. Smoke: mint 1 hWETH, approve exactly 1 hWETH, swap for hUSDC, replay (account 2 sends)
forge script test/harness/HarnessSmoke.s.sol --rpc-url http://127.0.0.1:8645 --broadcast \
  --unlocked --sender 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

# 3. Re-check against the chain (no broadcast)
forge script test/harness/HarnessSmoke.s.sol --sig 'check()' --rpc-url http://127.0.0.1:8645 \
  --sender 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
```

Expected on a fresh anvil (verified on 2026-10-15): the deploy logs `FeeWrapper 0x60A10abb52c31ec38f1f93c70B64D2Fb00913859` and `router allowed 0xC0b06d1E9E0bb6e4b5d903A2b5afc57e1bF41Ce2`. The smoke logs `replay reverts NonceAlreadyUsed (0x1fb09b80)` and `smoke ok: user received hUSDC 2994000000`. `check()` confirms that the user holds 2,994 hUSDC, the collector holds exactly the 0.002 hWETH fee, the wrapper holds nothing and its allowance to the holder is 0, and the replay reverts `NonceAlreadyUsed`. The smoke uses a fixed nonce and deadline, so it runs once per fresh anvil.

To deploy only the wrapper, run `forge script script/Deploy.s.sol` with the same environment and `--unlocked --sender` as step 1. It lands at the same address.

```sh
cast call 0x60A10abb52c31ec38f1f93c70B64D2Fb00913859 \
  'eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])' --rpc-url http://127.0.0.1:8645
# the 4th value must be 31337
```

The wrapper address changes if `FeeWrapper.sol`, the salt or the constructor arguments change.

## TypeScript smoke (built)

`apps/api/scripts/harness/smoke.ts` runs the API's own code (`quoteFee`, `vetRoute` through `compareProviderQuotes`, `LocalKeySigner` allowed for `[31337]` only, `canSignChain`, `buildSignedSwap`, `signedAnswerEcho`, and once the whole `POST /v1/quotes` handler in process) against the pinned contracts, and sends the user's transactions (anvil account 2, signed locally with chain ID 31337). Every scenario asserts on-chain state: the happy path, replay (`NonceAlreadyUsed`), the under-oracle route refused by `vetRoute`, the underpaying router (`InsufficientOutput`), expiry (`QuoteExpired`, chain time restored with `evm_revert`), a signature for chain 8453 and a tampered fee (`InvalidSignature`), routers off the allowlist (`unknown_router`, `unknown_target`, `RouterNotAllowed`), native input and native output.

```sh
pnpm harness:smoke    # its own anvil on a free 127.0.0.1 port, DeployHarness, the smoke, then stops that anvil by PID
                      # skipped with a message when anvil or forge is not on PATH or in ~/.foundry/bin

# against an anvil you started and deployed with the manual steps above:
RANVIER_HARNESS_RPC_URL=http://127.0.0.1:8645 pnpm --filter @ranvier/api harness:smoke:rpc
```

Before it builds any client, the smoke refuses an RPC URL that is not exactly `http://127.0.0.1:<port>` or `http://[::1]:<port>` (no request is sent), then one that does not answer `eth_chainId` 31337 (nothing else is sent). It then checks the pinned table on chain (code at every address, `eip712Domain()` name, version and chain ID, `feeSigner()`, `feeCollector()`, and a router allowlist rebuilt from `RouterSet` events that must be exactly the mock holder) before it sends a transaction. It takes addresses only from `apps/api/src/harness/pinned.ts`, which holds no address literal: it imports them from `@ranvier/chains/local-dev` (below). A unit test (`pinned.test.ts`) compares that module, row by row and in checksummed form, with `HarnessConfig.sol` and the table above, and the smoke's preflight also checks hUSDC's and hWETH's symbol, name and decimals on chain. The smoke code lives under `apps/api/scripts/`, which the API build (`tsconfig.build.json`, `rootDir: src`) never compiles.

## Harness API (built)

The real API server on the local chain. Start anvil and deploy with the manual steps above, then:

```sh
RANVIER_ENV=harness ZEROX_CHAIN_IDS=31337 RPC_URLS_EVM_31337=http://127.0.0.1:8645 pnpm harness:api
# prints: harness API (chain 31337 only, PUBLIC anvil keys, not real funds): http://127.0.0.1:4310
# optional: PORT (default 4310, never 3000), HOST (127.0.0.1 or ::1), WEB_ORIGINS (loopback only)
```

It is `apps/api/src/harness/main.ts`, run with `tsx`. `tsconfig.build.json` leaves `src/harness/` out of `dist/`. Tests check that `dist/` holds none of it and that no production module reaches it. The server is the production `buildServer` code, with these differences:

- the chain catalog: the registry plus `LOCAL_DEV_CHAIN`, through `buildServerWithCatalog`. Production `buildServer` refuses any catalog;
- the 0x-shaped `HarnessQuoteProvider` and the `FixedPriceOracle`;
- the route policy `{31337: mock AllowanceHolder -> MockSettler}`;
- `LocalKeySigner` with anvil account 1 (a PUBLIC anvil key, chain 31337 only, derived in memory), allowed for `[31337]` written as a literal.

It refuses to start, naming the reason, unless all of these hold. Every check before the chain ID check runs before any request is sent, and none of them opens a port:

1. `RANVIER_ENV` is exactly `harness`, and `NODE_ENV` is not `production`.
2. `ZEROX_CHAIN_IDS` is exactly `31337`.
3. None of `KMS_KEY_ID`, `KMS_EXPECTED_SIGNER_ADDRESS`, `ZEROX_API_KEY`, `QUOTE_SIGNER_PRIVATE_KEY` or `LOCAL_SIGNER_CHAIN_IDS` is present, not even empty.
4. RPC variables:
   - no `RPC_URLS_EVM_<id>` is set for another chain;
   - `RPC_URLS_EVM_31337` is exactly one `http://127.0.0.1:<port>` or `http://[::1]:<port>` (not port 3000);
   - `RANVIER_HARNESS_RPC_URL`, if set, is the same URL.
5. `HOST` and `WEB_ORIGINS` are loopback, and `PORT` is not 3000.
6. `FEE_WRAPPER_ADDRESS`, if set, is the pinned wrapper.
7. The endpoint answers `eth_chainId` 31337. This sends one request.
8. The production on-chain signer check passes. It reads the code, `feeSigner()` and `eip712Domain()` of the pinned wrapper.

At runtime it re-checks `feeSigner()` every 10 minutes, like production. If `feeSigner` has been rotated, signing stops (`503 signing_unavailable`).

Balances: plain anvil has no Multicall3 (nothing at `0xcA11…CA11`; checked with anvil 1.8.3). 31337 is not one of the reader's Multicall3 chains, so `POST /v1/balances` uses the reader's existing individual-call fallback (ADR 0009), with every call pinned to one block. Nothing is deployed for it, and production is unchanged. Anvil mines only on demand, so the harness allows blocks up to a day old (or a day ahead, after `evm_increaseTime`).

What it does not do:

- **No direct wraps.** ETH to hWETH is not a direct wrap: the fee schedule reads the registry, and the registry does not know chain 31337.
- **Mock pairs only.** It quotes only the MockSettler pairs.

Tests:

- `apps/api/src/harness/start.test.ts`: every refusal above against a fake node. Each test proves that nothing was sent (for the environment checks) and that the port stayed closed.
- `apps/api/scripts/harness/harness-api.harness.test.ts`: the real entry against its own anvil and `DeployHarness`, all over HTTP. It covers:
  - `/v1/chains`, `/v1/tokens`, and `/v1/balances` for the funded user;
  - `/v1/quotes`, then the approval and swap sent as the user, with the smoke's scenario 1 checks;
  - a rotated `feeSigner`: a new start is refused, and the running API answers 503 until the chain is reverted.

  It runs with `pnpm harness:smoke`, or alone with `pnpm --filter @ranvier/api harness:api:test`, and is skipped without Foundry.

## Local chain config (built)

`@ranvier/chains/local-dev` (`packages/chains/src/local-dev.ts`) is the one TypeScript source of the local chain: `LOCAL_DEV_CHAIN` (key `evm:31337`, name "Local test chain (not a real network)", the registry's `ChainConfig` shape plus `chainId` and the tokens ETH, hWETH and hUSDC) and `LOCAL_DEV_CONTRACTS` (the mock holder and settler, the wrapper, the scenario tokens and the CREATE2 factory). Both are deep-frozen. hUSDC is deliberately not a stablecoin there: a mock token never selects a fee rate.

It is a subpath export only. It is never in the package index, `CHAINS`, `TOKEN_LIST`, `PUBLIC_RPC_URLS`, `TRUSTED_ROUTERS` or `ZEROX_SETTLERS`; putting 31337 into the registry or the router policy would also put it into `NEVER_LOCAL_CHAINS` and deny the harness key. Guards (ADR 0013, section 2):

- `packages/chains/src/local-dev.test.ts`: the module's data, deep freeze, absence from the registry, token list and RPC defaults, and no local-dev export from the index (runtime, TypeScript surface including types, and a fresh `tsc` build of the package);
- The harness's own 31337 rails are literals, never derived from local-dev: the RPC chain-ID check (`0x7a69`), anvil's `--chain-id 31337` and the smoke key's `allowedChainIds: [31337]`. `pinned.ts` refuses to load (and with it the whole smoke) if local-dev names any other chain (`pinned-refuses.test.ts`);
- `apps/api/scripts/harness/local-chain-guards.test.ts`: no 31337 or harness address in `CHAINS`, `TOKEN_LIST`, `TRUSTED_ROUTERS`, `ZEROX_SETTLERS` or the `/v1/chains` and `/v1/tokens` answers; 31337 in `LOCAL_SIGNER_DEFAULT_CHAINS` and not in `NEVER_LOCAL_CHAINS` (asserted, never changed);
- `apps/api/scripts/harness/import-graph.test.ts`: a static import graph over TypeScript and JavaScript files (`.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs`; static and type imports, `export *`, `export { } from`, `import()`, `require()`, `import x = require()`, `new URL('…', import.meta.url)`, `new Worker`/`new SharedWorker`, and `#…` specifiers through the owning package's `imports` map) from every production source file of `apps/api/src`, `apps/workers/src`, `apps/web/src` (plus `next.config.ts`) and `packages/*/src` reaches neither local-dev nor `apps/api/scripts/`, `apps/api/src/harness/` or `contracts/test/harness/`. Roots leave out only test files, local-dev itself and the planned `apps/api/src/harness/`. A dynamic reference it cannot follow, or a specifier it cannot resolve, fails the test;
- `apps/api/scripts/harness/build-output.test.ts`: the production source directories (every `apps/*/src` and `packages/*/src`, `apps/web/public`, `apps/web/next.config.ts`, `contracts/src`, `contracts/script`; not local-dev and its test) hold no harness address, local-dev export name or subpath, or harness path, so a pasted literal is caught outside the graph; and a real build of the API into a scratch directory holds none of those nor the chain's name or key. Addresses match case-insensitively on the bare 40-hex body (plain, `0x` and checksummed spellings); a value split mid-address or encoded would not match, so the import graph and the source scan are the primary guards;
- `pnpm guard:local-chain`: runs the source scan, builds the API and the web for real (`turbo run build --force`), then scans `apps/api/dist` and `apps/web/.next` (without `cache/` and `dev/`) for the same strings. `--no-build` scans the existing output. It is not in CI yet (the release gate is PR 7).

## CI (planned)

The harness gets its own workflow job, with no secrets:

1. `foundry-rs/foundry-toolchain@v1`, pinned by tag like the other actions;
2. `pnpm harness:up`, then `harness:smoke`, then `e2e:harness`, then `harness:down`.

A separate mandatory check fails the normal web build if `.next/` contains the local chain's key or name, a harness address, or the harness profile flag.

## Fork mode: deferred

The owner decided against fork mode for now. It needs an archive RPC (public endpoints answer `403 Archive requests require a personal token` for pinned blocks). Its addresses also differ from run to run, and its state cannot be snapshotted offline (ADR 0013, evidence 3). Do not start anvil with `--fork-url` for the harness.

## Troubleshooting

| Symptom                                                                | Cause and fix                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Harness API refuses: chain ID is not 31337, or the RPC is not loopback | anvil was started without `--chain-id 31337`, or a non-loopback URL is set. Restart anvil and fix the URL.                |
| Harness API refuses: `RPC_URLS_EVM_<id>` for another chain             | A variable was inherited from your shell. Unset it.                                                                       |
| Harness API refuses: `KMS_KEY_ID` (or another key variable) is set     | The harness uses only its own PUBLIC anvil key. Unset the variable, even if it is empty.                                  |
| `/v1/balances` answers 503 on the harness                              | anvil's newest block is over a day old, or a day ahead. Mine a block (`cast rpc anvil_mine`) or restart anvil.            |
| Harness API refuses: `feeSigner()` differs from the signer             | The wrapper was deployed with another `FEE_SIGNER`. Redeploy on a fresh anvil.                                            |
| Swap reverts `0x1fb09b80` (`NonceAlreadyUsed`)                         | The same signed quote was sent twice. Ask for a new quote.                                                                |
| Swap reverts `QuoteExpired`                                            | Chain time is past the deadline (for example after `evm_increaseTime`). Ask for a new quote.                              |
| `harness:up` says a port is in use                                     | Something else holds 8645, 4310 or 3310. Stop it yourself; the harness will not.                                          |
| Quotes fail with `below_oracle_value`                                  | Expected on the "under oracle" test pair. On a normal pair, the oracle constants and the settler rates disagree.          |
| `DeployHarness` reverts `MockAddressChanged`                           | A mock's code changed, so its CREATE2 address moved. Update `HarnessConfig.sol`, the address table and `local-dev.ts`.    |
| `DeployHarness` reverts `InitialRoutersSetByHarness`                   | `INITIAL_ROUTERS` is set in your shell. Unset it: the harness allowlists its own holder.                                  |
| A deploy reverts `PublishedDevAddress` or `InitialRoutersRefused`      | The role guard: a published address in a role off 31337, or initial routers off the listed testnets. Fix the environment. |

## What a green run means

The harness proves our code paths on a chain we control. It does not prove real 0x calldata, real AllowanceHolder behaviour, real liquidity, KMS signing, live chain behaviour or real wallet UX (ADR 0013, "What the harness proves").

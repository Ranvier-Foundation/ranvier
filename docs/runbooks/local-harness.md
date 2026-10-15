# Runbook: local chain test harness

Design: [ADR 0013](../adr/0013-local-fork-test-harness.md). Sections marked **(planned)** describe commands that do not exist yet. The mock contracts, `DeployHarness.s.sol`, the forge smoke script and the `Deploy.s.sol` role guard are built (PR 1). Nothing here uses real funds, a live network or a secret.

## Rules

- **Chain ID 31337, loopback only.** Start anvil with `--chain-id 31337 --host 127.0.0.1`. Every RPC URL the harness uses must be `http://127.0.0.1:<port>` or `http://[::1]:<port>`. 31337 is not reserved, so an endpoint answering 31337 elsewhere is refused all the same.
- **Published development accounts only.** Accounts come from anvil's published mnemonic (`test test test test test test test test test test test junk`). They are public, worthless and allowed only on 31337.
  - Never use them on a testnet or mainnet: off 31337, `Deploy.s.sol` refuses them in every role and as an initial router, before anything is broadcast (`PublishedDevAddress(role, account)`). It also refuses `address(0)`, `0x…01`, `0x…02` and the CREATE2 factory, and any `INITIAL_ROUTERS` on chains 1, 8453 and 42161 (`InitialRoutersRefused`).
  - Never put any other key into the harness.
  - Commands below use `--unlocked --sender <address>`, so no key is typed or stored.
- **Ports.** Anvil 8645, API 4310, web 3310, all on 127.0.0.1. **Never use or stop port 3000** (the owner's dev server). The harness only stops processes it started.
- **No `.env`.** The harness needs no `.env` file. Do not print or copy one.

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
5. starts the harness API (`RANVIER_ENV=harness`, `ZEROX_CHAIN_IDS=31337`, the local key allowed for `[31337]` only). The API checks `feeSigner()` on chain before it listens;
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

CREATE2 through the factory at `0x4e59b44847b379578588920cA78FbF26c0B4956C`. The mock addresses depend only on the salt and the init code, not on who deploys. `HarnessConfig.t.sol` recomputes them, and `DeployHarness` stops with `MockAddressChanged` if a deployed address differs. Changing a mock moves its address: update `HarnessConfig.sol` and this table in the same PR.

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

## CI (planned)

The harness gets its own workflow job, with no secrets:

1. `foundry-rs/foundry-toolchain@v1`, pinned by tag like the other actions;
2. `pnpm harness:up`, then `harness:smoke`, then `e2e:harness`, then `harness:down`.

A separate mandatory check fails the normal web build if `.next/` contains the local chain's key or name, a harness address, or the harness profile flag.

## Fork mode: deferred

The owner decided against fork mode for now. It needs an archive RPC (public endpoints answer `403 Archive requests require a personal token` for pinned blocks). Its addresses also differ from run to run, and its state cannot be snapshotted offline (ADR 0013, evidence 3). Do not start anvil with `--fork-url` for the harness.

## Troubleshooting

| Symptom                                                                | Cause and fix                                                                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Harness API refuses: chain ID is not 31337, or the RPC is not loopback | anvil was started without `--chain-id 31337`, or a non-loopback URL is set. Restart anvil and fix the URL.       |
| Harness API refuses: `RPC_URLS_EVM_<id>` for another chain             | A variable was inherited from your shell. Unset it.                                                              |
| Harness API refuses: `feeSigner()` differs from the signer             | The wrapper was deployed with another `FEE_SIGNER`. Redeploy on a fresh anvil.                                   |
| Swap reverts `0x1fb09b80` (`NonceAlreadyUsed`)                         | The same signed quote was sent twice. Ask for a new quote.                                                       |
| Swap reverts `QuoteExpired`                                            | Chain time is past the deadline (for example after `evm_increaseTime`). Ask for a new quote.                     |
| `harness:up` says a port is in use                                     | Something else holds 8645, 4310 or 3310. Stop it yourself; the harness will not.                                 |
| Quotes fail with `below_oracle_value`                                  | Expected on the "under oracle" test pair. On a normal pair, the oracle constants and the settler rates disagree. |
| `DeployHarness` reverts `MockAddressChanged`                           | A mock's code changed, so its CREATE2 address moved. Update `HarnessConfig.sol` and the address table.           |
| `DeployHarness` reverts `InitialRoutersSetByHarness`                   | `INITIAL_ROUTERS` is set in your shell. Unset it: the harness allowlists its own holder.                         |
| A deploy reverts `PublishedDevAddress` or `InitialRoutersRefused`      | The role guard: a published address in a role off 31337, or initial routers on a mainnet. Fix the environment.   |

## What a green run means

The harness proves our code paths on a chain we control. It does not prove real 0x calldata, real AllowanceHolder behaviour, real liquidity, KMS signing, live chain behaviour or real wallet UX (ADR 0013, "What the harness proves").

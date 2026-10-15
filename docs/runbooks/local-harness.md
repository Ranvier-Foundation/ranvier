# Runbook: local chain test harness

Design: [ADR 0013](../adr/0013-local-fork-test-harness.md). Sections marked **(planned)** describe commands that do not exist yet. Nothing here uses real funds, a live network or a secret.

## Rules

- **Chain ID 31337, loopback only.** Start anvil with `--chain-id 31337 --host 127.0.0.1`. Every RPC URL the harness uses must be `http://127.0.0.1:<port>` or `http://[::1]:<port>`. 31337 is not reserved, so an endpoint answering 31337 elsewhere is refused all the same.
- **Published development accounts only.** Accounts come from anvil's published mnemonic (`test test test test test test test test test test test junk`). They are public, worthless and allowed only on 31337.
  - Never use them on a testnet or mainnet: `Deploy.s.sol` refuses them in every role off 31337 (planned guard).
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
2. runs `DeployHarness.s.sol` (the mocks), then the unchanged `Deploy.s.sol` with `INITIAL_ROUTERS` set to the mock AllowanceHolder;
3. checks the deployed addresses against `@ranvier/chains/local-dev`, and stops with "mocks changed: update local-dev addresses" if they differ;
4. funds account 2 with `anvil_setBalance` and the harness tokens' `mint`;
5. starts the harness API (`RANVIER_ENV=harness`, `ZEROX_CHAIN_IDS=31337`, the local key allowed for `[31337]` only). The API checks `feeSigner()` on chain before it listens;
6. builds the web with `RANVIER_BUILD_PROFILE=harness` into `.next-harness` and serves it on 3310.

## Manual steps (work today)

These steps deploy the real wrapper on a local 31337 chain. They need no harness code and no key.

```sh
export PATH="$HOME/.foundry/bin:$PATH"
anvil --host 127.0.0.1 --port 8645 --chain-id 31337 --silent &
echo $! > /tmp/ranvier-anvil.pid           # later: kill "$(cat /tmp/ranvier-anvil.pid)"

cd contracts
export FEE_WRAPPER_SALT=0x0000000000000000000000000000000000000000000000000000000052414e56
export ADMIN_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 GUARDIAN_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
export FEE_COLLECTOR=0x90F79bf6EB2c4f870365E785982E1f101E93b906 FEE_SIGNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8645 --broadcast \
  --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

cast call 0x60A10abb52c31ec38f1f93c70B64D2Fb00913859 \
  'eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])' --rpc-url http://127.0.0.1:8645
# the 4th value must be 31337
```

The wrapper lands at `0x60A10abb52c31ec38f1f93c70B64D2Fb00913859` on a fresh anvil (verified on 2026-10-15). That address changes if `FeeWrapper.sol`, the salt or the constructor arguments change.

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

## What a green run means

The harness proves our code paths on a chain we control. It does not prove real 0x calldata, real AllowanceHolder behaviour, real liquidity, KMS signing, live chain behaviour or real wallet UX (ADR 0013, "What the harness proves").

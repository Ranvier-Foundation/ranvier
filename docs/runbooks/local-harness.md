# Runbook: local chain test harness

Design: [ADR 0013](../adr/0013-local-fork-test-harness.md). Sections marked **(planned)** describe commands that do not exist yet. Nothing here uses real funds, a real network or a secret.

## Rules

- Local chain ID is always **31337**. Never start anvil for the harness without `--chain-id 31337`: a fork reports its parent's chain ID (8453, 1, ...) by default, and the harness refuses it.
- Keys are anvil's **published** development keys (mnemonic `test test test test test test test test test test test junk`). They are public, worthless and allowed only on 31337. Never put them on a testnet or mainnet, and never put any other key into the harness.
- Ports: anvil 8645, API 4310, web 3310, all on 127.0.0.1. **Never use or stop port 3000** (the owner's dev server). The harness never stops a process it did not start.
- Do not print or copy any `.env` file. The harness needs no `.env`.

| Role                       | Anvil account | Used as                                      |
| -------------------------- | ------------- | -------------------------------------------- |
| deployer, owner, guardian  | 0             | `ADMIN_ADDRESS`, `GUARDIAN_ADDRESS`          |
| fee signer                 | 1             | `FEE_SIGNER`, API `QUOTE_SIGNER_PRIVATE_KEY` |
| test user (browser wallet) | 2             | the harness EIP-6963 wallet                  |
| fee collector              | 3             | `FEE_COLLECTOR`                              |

Foundry is not on `PATH` by default: `export PATH="$HOME/.foundry/bin:$PATH"`.

## One command (planned)

```sh
pnpm harness:up       # anvil, deploy, fund, API, web; prints the URLs
pnpm harness:smoke    # approve + swap from a script, no browser
pnpm e2e:harness      # Playwright signing suite against the running stack
pnpm harness:down     # stops exactly the PIDs in .harness/pids.json
```

`harness:up` refuses to start if any harness port is already in use. Run `harness:down` first, or find what holds the port yourself. It never kills by name or pattern.

What `harness:up` does, in order:

1. `anvil --host 127.0.0.1 --port 8645 --chain-id 31337 --silent`, then checks `eth_chainId == 31337`.
2. `forge script contracts/script/harness/DeployHarness.s.sol`: mock tokens, `HarnessWETH`, `MockAllowanceHolder` and `MockSettler`, deployed with a fixed CREATE2 salt.
3. `forge script contracts/script/Deploy.s.sol` (unchanged), with the environment in "Manual steps" below and `INITIAL_ROUTERS` = the mock AllowanceHolder.
4. Compares the deployed addresses with `@ranvier/chains/local-dev`, and stops with "mocks changed: update local-dev addresses" if they differ.
5. Funds account 2: `anvil_setBalance` (100 ETH) and `mint` on the harness tokens.
6. Starts the harness API (`tsx apps/api/src/harness/main.ts`) with `RANVIER_ENV=harness`, `ZEROX_CHAIN_IDS=31337`, the anvil RPC, the wrapper address and the account-1 key. The API checks `feeSigner()` on chain before it listens.
7. Builds the web with `RANVIER_BUILD_PROFILE=harness` into `.next-harness` and starts it on 3310.

## Manual steps (work today)

These steps reproduce the part of the ADR's evidence that needs no harness code: the wrapper deployed by the real script on a local 31337 chain.

```sh
export PATH="$HOME/.foundry/bin:$PATH"
anvil --host 127.0.0.1 --port 8645 --chain-id 31337 --silent &
echo $! > /tmp/ranvier-anvil.pid           # stop it later with: kill "$(cat /tmp/ranvier-anvil.pid)"

cd contracts
export FEE_WRAPPER_SALT=0x0000000000000000000000000000000000000000000000000000000052414e56
export ADMIN_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266     # anvil 0
export GUARDIAN_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # anvil 0
export FEE_COLLECTOR=0x90F79bf6EB2c4f870365E785982E1f101E93b906     # anvil 3
export FEE_SIGNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8        # anvil 1
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8645 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil 0, public

W=<printed FeeWrapper address>
cast call $W 'eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])' --rpc-url http://127.0.0.1:8645
# the 4th value must be 31337
```

The private key on the command line is acceptable **only** because it is anvil's public key 0. Use `--interactive` for any other key (see [testnet-deploy.md](testnet-deploy.md)).

## Fork mode (planned, optional, never in CI)

Fork mode adds real token contracts (for example USDT's approve rule) on top of the mock router. It needs an **archive** RPC URL of your own. Public endpoints refuse pinned blocks (`403 Archive requests require a personal token`).

```sh
export HARNESS_FORK_URL=<your archive RPC URL>   # from your shell or password manager, never committed
pnpm harness:up --fork base --fork-block <pinned block>
```

Expect the following, and do not "fix" it by dropping `--chain-id 31337`:

- anvil's accounts have real mainnet history on a fork, so deploy addresses differ from plain mode. Fork mode reads them from the deploy output and does not use the committed constants.
- Tokens are funded with forge-std `deal` (storage write), never by impersonating a holder.
- `--dump-state` does not keep forked state that was only read, so there is no offline fork snapshot.

## CI (planned)

A separate workflow job:

1. installs Foundry with `foundry-rs/foundry-toolchain`, pinned by commit SHA;
2. runs `pnpm harness:up`, `pnpm harness:smoke`, `pnpm e2e:harness` and `pnpm harness:down` in plain mode.

It needs no secrets. The normal web build job separately checks that `.next/` contains no local-chain key, name or harness address.

## Troubleshooting

| Symptom                                                         | Cause and fix                                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| API refuses: `eth_chainId` is 8453 or 1                         | anvil was started without `--chain-id 31337`. Restart it with the flag.                                          |
| API refuses: `feeSigner()` differs from the signer              | The wrapper was deployed with another `FEE_SIGNER`. Redeploy on a fresh anvil.                                   |
| Swap reverts `0x1fb09b80` (`NonceAlreadyUsed`)                  | The same signed quote was sent twice. Ask for a new quote.                                                       |
| Swap reverts `QuoteExpired`                                     | The chain time is past the deadline (for example after `evm_increaseTime`). Ask for a new quote.                 |
| `harness:up` says a port is in use                              | Something else holds 8645, 4310 or 3310. Stop it yourself; the harness will not.                                 |
| Quotes fail with `rejected_unsafe_route` / `below_oracle_value` | Expected on the "under oracle" test pair. On a normal pair, the oracle constants and the settler rates disagree. |

## What a green run means

The harness proves our code paths on a chain we control. It does not prove real 0x calldata, real liquidity, KMS signing, live chain behaviour or real wallet UX. Those remain for Base Sepolia, the manual wallet matrix and the audits (ADR 0013, "What the harness proves").

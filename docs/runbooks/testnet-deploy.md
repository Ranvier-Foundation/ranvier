# Runbook: deploy the fee wrapper to a testnet

Target: **Base Sepolia** (chain ID 84532). Testnet keys only; never reuse them on mainnet.

## 1. Create testnet keys

```sh
cast wallet new   # deployer: also owner, collector and guardian on testnet
cast wallet new   # fee signer: goes into the API's QUOTE_SIGNER_PRIVATE_KEY
```

Store both private keys in your password manager. Fund the **deployer** with Base Sepolia ETH from a faucet (e.g. the Coinbase Developer Platform faucet). 0.01 ETH is plenty.

## 2. Deploy

From `contracts/`:

```sh
export FEE_WRAPPER_SALT=0x$(openssl rand -hex 32)
export ADMIN_ADDRESS=<deployer address>
export FEE_COLLECTOR=<deployer address>
export GUARDIAN_ADDRESS=<deployer address>
export FEE_SIGNER=<fee signer address>
export INITIAL_ROUTERS=0x0000000000001fF3684f28c67538d4D072C22734   # 0x AllowanceHolder
```

Before you run the script with `--broadcast`, confirm the RPC is the network you intend:

```sh
cast chain-id --rpc-url https://sepolia.base.org   # must print 84532
```

Never deploy to chain ID 31337 outside the local harness. The role guard below is skipped on 31337 by design (the harness uses the published test accounts there), and 31337 is not a reserved ID: any node, including a fork of a real network, can report it.

```sh
forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org \
  --interactive --broadcast \
  --verify --etherscan-api-key <Etherscan API key>
```

`--interactive` prompts for the deployer key so it never lands in shell history. Keep the salt: the same salt and constructor arguments give the same address on other chains.

Before anything is broadcast, the script refuses a published development address in any role or as an initial router: the first 30 anvil and Hardhat test accounts, every address up to `0x…01ff` (`address(0)` and the precompiles, including P256 at `0x…0100`), the CREATE2 factory, forge's default sender and its test contract addresses (`0x7FA9…1496` and forge-std's `DEFAULT_TEST_CONTRACT` `0x5615…b72f`), and the burn addresses `0x…dEaD` and `0xdEAD…2069`. It fails with `PublishedDevAddress(<role>, <address>)`. Use the fresh keys from step 1.

`INITIAL_ROUTERS` is a comma-separated address list. Unset or empty means no routers. It may be non-empty only on Base Sepolia (84532), Sepolia (11155111), Arbitrum Sepolia (421614) and the local chain 31337; on any other chain ID, mainnet or unknown, the script fails with `InitialRoutersRefused(<chainId>)`. A malformed value (an empty item, a trailing comma, a wrong-length or non-hex address) stops the script instead of being read as "no routers", a duplicate entry fails with `DuplicateInitialRouter(<address>)`, and a router that is also the owner, guardian, collector or signer fails with `RouterIsRole(<role>, <address>)`.

### Take the wrapper address from the broadcast file, not the log

With the earlier script (`new FeeWrapper{salt: ...}`), forge's OP-stack network mode sends the deploy as a plain `CREATE` from the deployer while the script logs the CREATE2 address. That mode is switched on for OP-stack chains such as Base Sepolia and Base mainnet, and for their RPCs, whatever flags you pass (`--always-use-create-2-factory` and `--create2-deployer` do not change it). The logged address then has no code, the wrapper lands at a nonce-based address, and the `INITIAL_ROUTERS` calls go to the empty logged address, so the real wrapper has no router.

The current script calls the CREATE2 factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) directly. forge broadcasts that call as written, so the wrapper lands at the same address on every chain for the same salt and roles. The script stops if the factory has no code, if a wrapper already exists at that address, if the factory call fails or returns another address, or if a router is not allowlisted afterwards.

Still, take the address only from the broadcast file. The entry has `transactionType` `CREATE2` (to the factory) or, for any older deploy, `CREATE`; `contractName` is null for a plain `CREATE`, so match on the type:

```sh
jq -r '.transactions[] | select(.transactionType == "CREATE" or .transactionType == "CREATE2") | .contractAddress' \
  broadcast/Deploy.s.sol/84532/run-latest.json
W=<that address>
cast code $W --rpc-url https://sepolia.base.org                    # must not be 0x
cast call $W 'eip712Domain()' --rpc-url https://sepolia.base.org   # must answer
```

Then run step 3, including `isRouterAllowed`. `FEE_WRAPPER_ADDRESS` in the API config and the wrapper pin in the web app take this address from `run-latest.json`, never from the console log.

`vm.envAddress` does not validate EIP-55 checksums: an address with a wrong mixed-case checksum is accepted as is. Double-check every role address and router against its source before you broadcast.

## 3. Check

```sh
W=<wrapper address from run-latest.json>
cast call $W 'feeSigner()(address)' --rpc-url https://sepolia.base.org
cast call $W 'isRouterAllowed(address)(bool)' 0x0000000000001fF3684f28c67538d4D072C22734 --rpc-url https://sepolia.base.org
```

## 4. Point the API at it

In `apps/api/.env`: `FEE_WRAPPER_ADDRESS=<wrapper address>`, `QUOTE_SIGNER_PRIVATE_KEY=<fee signer key>` and `ZEROX_CHAIN_IDS=84532`.

A local key only signs for testnet and local chain IDs (default 84532, 11155111, 421614, 31337; see `LOCAL_SIGNER_CHAIN_IDS`). The API refuses to start if a local key is set and `ZEROX_CHAIN_IDS` includes a mainnet (ADR 0004). For end-to-end tests against mainnet state, use an Anvil fork under chain ID 31337 with a throwaway key, never a mainnet chain ID.

Limitation: the API signs only routes whose AllowanceHolder target is a trusted 0x Settler (`ZEROX_SETTLERS`, mainnets only), and 0x does not serve testnet or fork chain IDs. The signed-quote path therefore cannot yet run end to end on a testnet or a 31337 fork. That needs a reviewed fork mode (ADR 0004). Until then, test the wrapper on the testnet with `cast`, and test the API with its unit tests.

## Mainnet differences

- Owner is the admin multisig behind a timelock, guardian the guardian multisig, collector the fee-collector Safe. Do not set `INITIAL_ROUTERS`; the multisig allowlists routers. On every chain except 84532, 11155111, 421614 and 31337 the script refuses a non-empty `INITIAL_ROUTERS` (`InitialRoutersRefused`).
- The fee signer is an AWS KMS key, not a local key: set it up with [kms-setup.md](kms-setup.md) and use the address its smoke test prints as `FEE_SIGNER`. The API runs with `KMS_KEY_ID` (the full key ARN), `KMS_EXPECTED_SIGNER_ADDRESS` (the same address as `FEE_SIGNER`) and `AWS_REGION`, and without `QUOTE_SIGNER_PRIVATE_KEY`; the signer address must never hold funds or be used for anything else; only a KMS signer may sign for mainnets, and only on chains with trusted routers (ADR 0005).
- Two independent audits first (spec section 9).

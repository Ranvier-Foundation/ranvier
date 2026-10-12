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

forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org \
  --interactive --broadcast \
  --verify --etherscan-api-key <Etherscan API key>
```

`--interactive` prompts for the deployer key so it never lands in shell history. The script prints the wrapper address. Keep the salt: the same salt and constructor arguments give the same address on other chains.

## 3. Check

```sh
W=<wrapper address>
cast call $W 'feeSigner()(address)' --rpc-url https://sepolia.base.org
cast call $W 'isRouterAllowed(address)(bool)' 0x0000000000001fF3684f28c67538d4D072C22734 --rpc-url https://sepolia.base.org
```

## 4. Point the API at it

In `apps/api/.env`: `FEE_WRAPPER_ADDRESS=<wrapper address>`, `QUOTE_SIGNER_PRIVATE_KEY=<fee signer key>` and `ZEROX_CHAIN_IDS=84532`.

A local key only signs for testnet and local chain IDs (default 84532, 11155111, 421614, 31337; see `LOCAL_SIGNER_CHAIN_IDS`). The API refuses to start if a local key is set and `ZEROX_CHAIN_IDS` includes a mainnet (ADR 0004). For end-to-end tests against mainnet state, use an Anvil fork under chain ID 31337 with a throwaway key, never a mainnet chain ID.

Limitation: the API signs only routes whose AllowanceHolder target is a trusted 0x Settler (`ZEROX_SETTLERS`, mainnets only), and 0x does not serve testnet or fork chain IDs. The signed-quote path therefore cannot yet run end to end on a testnet or a 31337 fork. That needs a reviewed fork mode (ADR 0004). Until then, test the wrapper on the testnet with `cast`, and test the API with its unit tests.

## Mainnet differences

- Owner is the admin multisig behind a timelock, guardian the guardian multisig, collector the fee-collector Safe. Do not set `INITIAL_ROUTERS`; the multisig allowlists routers.
- The fee signer is an AWS KMS key, not a local key: set it up with [kms-setup.md](kms-setup.md) and use the address its smoke test prints as `FEE_SIGNER`. The API runs with `KMS_KEY_ID` (the full key ARN), `KMS_EXPECTED_SIGNER_ADDRESS` (the same address as `FEE_SIGNER`) and `AWS_REGION`, and without `QUOTE_SIGNER_PRIVATE_KEY`; the signer address must never hold funds or be used for anything else; only a KMS signer may sign for mainnets, and only on chains with trusted routers (ADR 0005).
- Two independent audits first (spec section 9).

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

In `apps/api/.env`: `FEE_WRAPPER_ADDRESS=<wrapper address>` and `QUOTE_SIGNER_PRIVATE_KEY=<fee signer key>`.

## Mainnet differences

- Owner is the admin multisig behind a timelock, guardian the guardian multisig, collector the fee-collector Safe. Do not set `INITIAL_ROUTERS`; the multisig allowlists routers.
- The fee signer is a KMS key, not a local key.
- Two independent audits first (spec section 9).

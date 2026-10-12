# Runbook: update the trusted 0x Settlers

The API signs a quote only if the AllowanceHolder calldata targets a 0x Settler listed for that chain in `ZEROX_SETTLERS` (`apps/api/src/trusted-routers.ts`). The list fails closed (ADR 0004): when 0x rotates its Settler, the API refuses quotes that use the new one until the list is updated. Refusals are logged as `provider quote failed` with `error: rejected_unsafe_route` and `err.message: unsafe route: unknown_target`.

## When

- The `unknown_target` rate rises on a chain (a quote that 0x serves from a Settler we do not list).
- The weekly check below finds a difference.
- 0x announces a new Settler deployment.

## 1. Read the registry

The 0x Deployer registry is at `0x00000000000004533Fe15556B1E086BB1A72cEae` on every chain. Feature 2 is the taker-submitted Settler that AllowanceHolder quotes use. Use at least two independent RPC providers for each chain and check that they agree:

```sh
R=0x00000000000004533Fe15556B1E086BB1A72cEae
for RPC in https://ethereum-rpc.publicnode.com <second Ethereum RPC>; do
  cast call $R 'ownerOf(uint256)(address)' 2 --rpc-url $RPC   # current Settler
  cast call $R 'prev(uint128)(address)' 2 --rpc-url $RPC      # previous Settler
done
```

Repeat for Base (8453) and Arbitrum One (42161), and for every chain in `ZEROX_CHAIN_IDS`. If `ownerOf` reverts, the feature is paused: do not add anything, and expect quotes on that chain to fail until 0x unpauses.

## 2. Cross-check

- Check that the address is a verified contract named like `<Chain>Settler` on the chain's explorer, created by the 0x deployer.
- Check that a fresh 0x quote on that chain (`/swap/allowance-holder/quote`) has its AllowanceHolder `target` equal to `ownerOf(2)` or `prev(2)`.
- Check against 0x's published Settler addresses or announcements if available.

## 3. Update the list

- Set the chain's entry in `ZEROX_SETTLERS` to exactly `[ownerOf(2), prev(2)]`, lowercased, and update the date in the comment above it. Remove addresses that are no longer current or previous.
- Open a PR titled `chore(api): rotate 0x Settlers on <chains>`. In the description, give the registry outputs and the RPCs used. It needs security-reviewer approval like any change to signing.
- After deployment, check that `unknown_target` refusals for that chain stop.

## 4. Do not

- Do not add a Settler on the strength of an API response alone. A compromised response is exactly what this list defends against.
- Do not relax the check, or fall back to "any target", to restore availability. A chain without quotes is the safe failure.
- Do not list Settlers for other features (metatransaction, intents, bridge) unless the API starts using those flows and ADR 0004 is updated.

## Weekly check (until it is automated)

Run step 1 for every configured chain and compare with `ZEROX_SETTLERS`. Planned: a read-only worker job in `apps/workers` that does this comparison and alerts. It must never edit the list.

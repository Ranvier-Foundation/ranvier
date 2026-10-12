# Runbook: curated token list

The token list lives in `packages/chains/src/tokens.ts` (`TOKEN_LIST`). It feeds the token picker (`GET /v1/tokens`), and it is the single source of the registry's `knownDecimals` for each chain with a list. Those decimals are trusted input to fee tiers and route vetting (ADR 0004, ADR 0006). **Every change is a reviewed PR that goes to the security reviewer.**

## Who may list a token

A token is listed only if all of these hold:

- It is established, with deep liquidity on the chain, and native to the chain or bridged through the chain's canonical bridge.
- It is not rebasing and not fee-on-transfer. The fee wrapper refuses both on-chain, so such a swap would only revert.
- Its issuer cannot freeze, pause or blacklist holders behind an upgradeable proxy.
  - **Accepted exception:** USDC, and USDT (USDT0 on Arbitrum). Their issuers can upgrade, pause and blacklist them, and Tether's Ethereum USDT also has a dormant transfer-fee switch (`basisPointsRate`, 0 when last checked). We accept this because they are the core stablecoins.
  - Any other token with these powers (for example cbBTC) needs an explicit owner decision recorded in the PR.
- No other token on that chain in the list has the same symbol. Look-alikes are refused.

## Adding a token

1. **Source the address** from an authoritative reference: the issuer's documentation, or for bridged tokens the chain's bridge or token documentation, or a well-known curated list (Uniswap default list, CoinGecko token list). Never from memory, a search snippet or a block explorer's search box.
2. **Verify it independently**, on the same day:
   - DefiLlama:
     ```sh
     curl -s "https://coins.llama.fi/prices/current/<defillama-chain>:<address>"
     ```
     The symbol and decimals must match, and `confidence` should be at least 0.9, or the API cannot price it anyway.
   - On-chain (Foundry is at `~/.foundry/bin/cast`; use a public RPC):
     ```sh
     cast call <address> 'decimals()(uint8)' --rpc-url <rpc>
     cast call <address> 'symbol()(string)'  --rpc-url <rpc>
     cast call <address> 'name()(string)'    --rpc-url <rpc>
     ```
   - For a bridged token, check that it points at the L1 original:
     - OP Stack (Base): `remoteToken()(address)` and `bridge()(address)`, which must be `0x4200000000000000000000000000000000000010`.
     - Arbitrum: `l1Address()(address)` and `l2Gateway()(address)`.
   - Check for a proxy by reading the EIP-1967 implementation, admin and beacon slots, and the older ZeppelinOS implementation slot, with `cast storage`. Upgradeable tokens are recorded in the PR.

   If any check disagrees, or you have only one source, do not list the token.

3. **Add the entry** with:
   - `chain`;
   - `address`: lowercase on EVM;
   - `symbol`: the on-chain symbol, or a plain ASCII form of it, for example `USDT0` for `USD₮0`;
   - `name`;
   - `decimals`;
   - `tags`: `stablecoin` for stablecoins and `bridged` for canonical-bridge tokens.

   The `stablecoin` tag does not change fees. The stablecoin fee uses `stablecoins` in `registry.ts`, which is section 2 of the spec and needs its own fee review.

4. Run `pnpm --filter @ranvier/chains test`. It checks:
   - addresses are lowercase and unique;
   - symbols are unique;
   - each chain has exactly one native entry;
   - registry stablecoins and wrapped natives are present;
   - `knownDecimals` equals the list.
5. In the PR description, add a row for the token: address, sources, verification results and date. Send the PR to the security reviewer.

## Removing a token (routine)

1. Delete the entry and run the tests.
2. If the token is a registry stablecoin or wrapped native, the tests fail. That needs a fee-schedule decision, not just a list change.
3. Open a PR and send it to the security reviewer.

Removing a token only hides it from the picker and drops its checked-in decimals. Users can still quote it by address, with decimals from DefiLlama alone (ADR 0004).

## Emergency delisting

Use this when a listed token is exploited, paused, rugged, starts charging a transfer fee, or is found to be the wrong contract.

1. **Remove the entry** from `TOKEN_LIST` in a one-line PR titled `fix(chains): delist <SYMBOL> on <chain>`. Give the reason and a link to the evidence.
2. **Review.** The security reviewer approves with priority. CI must stay green; never skip it.
3. **Deploy the API and the web app.** Both bundle `@ranvier/chains`.
4. **Purge or wait out caches.** List responses are cached for 5 minutes (`Cache-Control: public, max-age=300`). If a CDN sits in front of the API, purge `/v1/tokens*`.
5. **If quotes must also stop** for the token, not just its listing, that is a separate change in the quote path (a denylist does not exist yet). Escalate to the security reviewer. Meanwhile the wrapper's on-chain checks still protect users:
   - fee-on-transfer swaps revert;
   - the output minimum is enforced.
6. Record the incident and the follow-up in the PR.

## Checking the list periodically

There is no automated check yet. Before each release, check every listed address again against DefiLlama with the command above (symbol and decimals), and read the issuers' announcements for migrations, for example a bridged token being replaced by a native issue.

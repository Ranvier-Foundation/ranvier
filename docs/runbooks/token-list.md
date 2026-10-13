# Runbook: curated token list

The token list lives in `packages/chains/src/tokens.ts` (`TOKEN_LIST`, deep-frozen). It has three jobs:

- It feeds the token picker (`GET /v1/tokens`).
- It is the single source of the registry's `knownDecimals` for each chain with a list. Those decimals are trusted input to fee tiers and route vetting (ADR 0004, ADR 0006).
- Its `stablecoin` tags must equal the registry's `stablecoins` allowlist, which sets the 0.05% stablecoin fee (spec section 2, ADR 0002).

**Every change is a reviewed PR that goes to the security reviewer. Every change runs `verify:tokens`.**

## Listing rules

A token is listed only if all of these hold:

- It is established, and native to the chain or bridged through the chain's canonical bridge (or, for a `bridged` token whose gateway is not a standard one, a written `bridgeExemption` with an on-chain check; see step 3).
- Its depth on that chain is recorded in the [depth table](#depth-on-each-chain). DefiLlama is evidence of identity and price only: its confidence says nothing about liquidity on a given chain. A thin token can be listed; it still routes only if a provider quotes it, and the quote still passes route vetting (ADR 0004).
- It is not rebasing and not fee-on-transfer. The fee wrapper refuses both on-chain, so such a swap would only revert.
- **Every power over the token held by a party that is not immutable code has a recorded decision** in the [risk table](#per-token-risk-record) below. Such powers include:
  - upgrading the contract (a proxy, including a beacon proxy);
  - pausing transfers;
  - blacklisting or freezing holders;
  - minting without a fixed bound.

  A token whose powers you cannot establish is not listed.

- No other token on that chain in the list has the same symbol, case-insensitively. Look-alikes are refused.

**Core issuer-controlled assets.** The owner accepts these for USDC, USDT (USDT0 on Arbitrum) and cbBTC:

- their issuers (Circle, Tether, Coinbase) can upgrade, pause and blacklist them;
- Tether's Ethereum USDT also has a dormant transfer-fee switch (`basisPointsRate`, 0 when last checked). If it is ever turned on, the wrapper refuses those swaps on-chain.

They are accepted because a swap aggregator without them is not useful, and every holder of them already accepts this trust model. Any other issuer-controlled token needs its own owner decision, recorded in the table.

## Per-token risk record

Checked on 2026-10-12. Each row:

- was sourced as listed;
- was verified with DefiLlama (symbol, decimals, confidence ≥ 0.9), which is evidence of identity and price only, not of depth on the chain (see [Depth on each chain](#depth-on-each-chain));
- was verified with on-chain `symbol()`, `name()` and `decimals()` reads via publicnode RPCs;
- was re-checked with `verify:tokens`, whose output is pasted in the PR that last changed this table.

Proxy kinds were read from storage slots (see [Detecting proxies](#detecting-proxies)).

Source abbreviations:

- **U**: Uniswap default token list.
- **CG**: CoinGecko token list.

### Ethereum (`evm:1`)

| Token | Address                                      | Sources                                                  | Powers held by a non-immutable party                                                                                                                      | Decision                        |
| ----- | -------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| WETH  | `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` | U, CG                                                    | None (immutable WETH9)                                                                                                                                    | Listed                          |
| USDC  | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | Circle docs, U, CG                                       | Circle: upgrade (FiatToken proxy), pause, blacklist, mint                                                                                                 | Core issuer-controlled asset    |
| USDT  | `0xdac17f958d2ee523a2206206994597c13d831ec7` | U, CG                                                    | Tether: pause, blacklist, mint; dormant transfer fee (`basisPointsRate` 0, `maximumFee` 0); `deprecate` redirect to a new contract (`deprecated()` false) | Core issuer-controlled asset    |
| DAI   | `0x6b175474e89094c44da98b954eedeac495271d0f` | U, CG                                                    | Maker/Sky governance (`wards`): mint                                                                                                                      | Accepted: core stablecoin       |
| WBTC  | `0x2260fac5e5542a773aa44fbcfedf7c193bc2c599` | U, CG                                                    | Owner (custodian): pause (not paused when checked), mint                                                                                                  | Accepted: established BTC asset |
| LINK  | `0x514910771af9ca656af840dff83e8264ecf986ca` | Chainlink docs, U, CG                                    | None (fixed supply, not a proxy)                                                                                                                          | Listed                          |
| UNI   | `0x1f9840a85d5af5bf1d1762f925bdaddc4201f984` | U (issuer), CG                                           | Uniswap governance (`minter`): mint, capped at 2% a year (`mintCap` 2)                                                                                    | Accepted: bounded mint          |
| AAVE  | `0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9` | U, CG                                                    | Aave governance: upgrade (EIP-1967 proxy)                                                                                                                 | Accepted: DAO-governed          |
| cbBTC | `0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf` | Coinbase AgentKit (`coinbase/agentkit` constants), U, CG | Coinbase: upgrade (FiatToken-style proxy, ZeppelinOS slot), pause, blacklist, mint. See [cbBTC control](#cbbtc-control-all-three-chains)                  | Core issuer-controlled asset    |

### Base (`evm:8453`)

| Token | Address                                      | Sources                           | Powers held by a non-immutable party                                                                                                                                           | Decision                     |
| ----- | -------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| WETH  | `0x4200000000000000000000000000000000000006` | Base docs (predeploy), U, CG      | None (WETH9 predeploy, not a proxy; changeable only by a Base network upgrade)                                                                                                 | Accepted: chain-level        |
| USDC  | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | Circle docs, U, CG                | Circle: upgrade, pause, blacklist, mint                                                                                                                                        | Core issuer-controlled asset |
| DAI   | `0x50c5725949a6f0c72e6c4a641f24049a917db0cb` | U, CG                             | Mint and burn only by the OP standard bridge (`bridge()` is `0x4200…0010`, `remoteToken()` is L1 DAI)                                                                          | Accepted: canonical bridge   |
| LINK  | `0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196` | Chainlink docs, CG                | Owner manages the CCIP minter set (3 minters when checked); mint bounded by `maxSupply` (1e9 LINK); not a proxy                                                                | Accepted: Chainlink CCIP     |
| UNI   | `0xc3de830ea07524a0761646a6a4e4be0e114a3c83` | U (issuer)                        | Mint and burn only by the OP standard bridge (`remoteToken()` is L1 UNI)                                                                                                       | Accepted: canonical bridge   |
| AERO  | `0x940181a94a35a4569e4529a3cdfb74e38fd98631` | Aerodrome contracts README, U, CG | `minter` is Aerodrome's emissions Minter contract (emissions schedule); not a proxy                                                                                            | Accepted: protocol emissions |
| cbBTC | `0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf` | Coinbase AgentKit, U, CG          | Coinbase: upgrade, pause, blacklist, mint (same implementation, admin, owner and pauser as on Ethereum; own blacklister). See [cbBTC control](#cbbtc-control-all-three-chains) | Core issuer-controlled asset |

### Arbitrum One (`evm:42161`)

| Token | Address                                      | Sources                                                | Powers held by a non-immutable party                                                                                                                                                                                                                          | Decision                     |
| ----- | -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| WETH  | `0x82af49447d8a07e3bd95bd0d56f35241523fbab1` | U, CG                                                  | aeWETH: upgrade (EIP-1967 proxy, Arbitrum governance); `l1Address()` is L1 WETH, gateway is the WETH gateway                                                                                                                                                  | Accepted: canonical bridge   |
| USDC  | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` | Circle docs, U, CG                                     | Circle: upgrade, pause, blacklist, mint                                                                                                                                                                                                                       | Core issuer-controlled asset |
| USDT0 | `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9` | USDT0 docs, U, CG                                      | Tether / USDT0: upgrade (EIP-1967 proxy, so any power can be added), blocklist (`isBlocked`), mint and burn via the OFT                                                                                                                                       | Core issuer-controlled asset |
| DAI   | `0xda10009cbd5d07dd0cecc66161fc93d7c9000da1` | U, CG                                                  | Maker's L2 Dai: mint via Maker's Dai gateway `0x467194771dae2967aef3ecbedd3bf9a310c76c65` (`wards(gateway)` is 1; the gateway's `l1Dai()` is L1 DAI and `l2Dai()` this token). No `l1Address()`, so `bridgeExemption` instead of `bridge`                     | Accepted: core stablecoin    |
| WBTC  | `0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f` | U, CG                                                  | Beacon proxy of the standard gateway: upgrade by the beacon owner (Arbitrum DAO upgrade executor, `0xcf57…a827`); mint by the gateway only; `l1Address()` is L1 WBTC                                                                                          | Accepted: canonical bridge   |
| LINK  | `0xf97f4df75117a78c1a5a0dbb814af92458539fb4` | Chainlink docs, U, CG                                  | As WBTC (beacon proxy, gateway mint); `l1Address()` is L1 LINK                                                                                                                                                                                                | Accepted: canonical bridge   |
| UNI   | `0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0` | U, CG                                                  | As WBTC (beacon proxy, gateway mint); `l1Address()` is L1 UNI                                                                                                                                                                                                 | Accepted: canonical bridge   |
| ARB   | `0x912ce59144191c1204e64559fe8253a0e49e6548` | Arbitrum Foundation docs, U, CG                        | Arbitrum DAO: upgrade (EIP-1967 proxy), owner mint capped at 2% a year                                                                                                                                                                                        | Accepted: DAO-governed       |
| cbBTC | `0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf` | U, CG; on-chain identity with Ethereum/Base deployment | Coinbase: upgrade, pause, blacklist, mint (same proxy bytecode, implementation, proxy admin, owner, pauser and master minter as the Coinbase-documented Ethereum and Base deployments; own blacklister). See [cbBTC control](#cbbtc-control-all-three-chains) | Core issuer-controlled asset |

Native coins (`native`, ETH on all three chains, 18 decimals) come from the registry and have no contract.

### cbBTC control (all three chains)

Read on-chain on 2026-10-12 (ZeppelinOS admin slot, `owner()`, `blacklister()`, `pauser()`, `masterMinter()`, and `cast codesize` of each address):

| Role           | Ethereum                                     | Base                                         | Arbitrum One                                 | Code    |
| -------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | ------- |
| Proxy admin    | `0x42d90b3faf2287475cdc863706bd7cc3e938c2af` | same                                         | same                                         | none    |
| Owner          | `0xbbc9b6001cf0a4fccffab7bdda1ab16cafb9db4f` | same                                         | same                                         | none    |
| Blacklister    | `0x5130bf38bf5342aa06cc79b8cc198cce832b01af` | `0x158cfa498b1f72f458acf8df993c709efca11e31` | `0x2b1565cd8bf6b5126cedb5000bc2d855bcbcedb8` | none    |
| Pauser         | `0x7399168043b684b57f198c42fc31558467cf2d6a` | same                                         | same                                         | none    |
| Master minter  | `0x2b5b99d0096a1ae5641f5041f780a33d004fc1d3` | same                                         | same                                         | none    |
| Implementation | `0x7458bfdc30034eb860b265e6068121d18fa5aa72` | same                                         | same                                         | (logic) |

The proxy admin and the owner have **no code** on any of the three chains: they are plain accounts (probably MPC-held keys), not a multisig or a timelock. Coinbase can therefore upgrade cbBTC to any implementation, or replace the blacklister, pauser and master minter, **instantly and with no on-chain delay**. The blacklister, pauser and master minter have no code either; the blacklister differs per chain, the others are shared. This is the core issuer-controlled trust model above and is accepted on that basis; it gives no warning window, so delisting after an incident is reactive only.

## Depth on each chain

DefiLlama confirms a token's identity and price, not its depth on a chain. Its `confidence` is about the price, and it can return one price for several chains: on 2026-10-12 it returned the same price and timestamp for cbBTC on Ethereum, Base and Arbitrum, and one shared price and timestamp for Base DAI and Arbitrum DAI. So depth is recorded separately here, as total supply read on-chain (`totalSupply()`, whole tokens, rounded down, 2026-10-12). Supply is an upper bound on liquidity, not a measure of it.

| Chain        | Token | Total supply   | Note                                |
| ------------ | ----- | -------------- | ----------------------------------- |
| Ethereum     | WETH  | 2,184,011      |                                     |
| Ethereum     | USDC  | 48,341,253,239 |                                     |
| Ethereum     | USDT  | 88,302,633,055 |                                     |
| Ethereum     | DAI   | 4,540,048,355  |                                     |
| Ethereum     | WBTC  | 116,132        |                                     |
| Ethereum     | LINK  | 1,000,000,000  |                                     |
| Ethereum     | UNI   | 1,000,000,000  |                                     |
| Ethereum     | AAVE  | 16,000,000     |                                     |
| Ethereum     | cbBTC | 44,441         |                                     |
| Base         | WETH  | 278,776        |                                     |
| Base         | USDC  | 4,460,651,267  |                                     |
| Base         | DAI   | 1,916,102      | Thin: about $1.9M in total          |
| Base         | LINK  | 206,486        | Thin                                |
| Base         | UNI   | 196,553        | Thin                                |
| Base         | AERO  | 1,997,645,621  |                                     |
| Base         | cbBTC | 47,625         |                                     |
| Arbitrum One | WETH  | 112,605        |                                     |
| Arbitrum One | USDC  | 2,626,836,231  |                                     |
| Arbitrum One | USDT0 | 824,933,822    |                                     |
| Arbitrum One | DAI   | 17,047,498     |                                     |
| Arbitrum One | WBTC  | 7,333          |                                     |
| Arbitrum One | LINK  | 1,876,267      |                                     |
| Arbitrum One | UNI   | 1,040,088      |                                     |
| Arbitrum One | ARB   | 9,999,998,977  |                                     |
| Arbitrum One | cbBTC | 67             | Thin: about 67.7 BTC, roughly $5.5M |

A thin token stays listed for display, but listing does not create liquidity: it routes only if a provider quotes it, and every quote still passes route vetting and the oracle bound (ADR 0004). Re-read this table when changing the list or before a release; a token whose supply collapses is a candidate for delisting.

## Adding a token

1. **Source the address** from an authoritative reference. That is one of:
   - the issuer's documentation;
   - for bridged tokens, the chain's bridge or token documentation;
   - a well-known curated list (Uniswap default list, CoinGecko token list).

   Never from memory, a search snippet or a block explorer's search box.

2. **Verify it independently**, on the same day:
   - DefiLlama:
     ```sh
     curl -s "https://coins.llama.fi/prices/current/<defillama-chain>:<address>"
     ```
     The symbol and decimals must match, and `confidence` must be at least 0.9, or the API cannot price it anyway.
   - On-chain (Foundry is at `~/.foundry/bin/cast`; use a public RPC):
     ```sh
     cast call <address> 'decimals()(uint8)' --rpc-url <rpc>
     cast call <address> 'symbol()(string)'  --rpc-url <rpc>
     cast call <address> 'name()(string)'    --rpc-url <rpc>
     ```
   - For a bridged token, check that it points at the L1 original:
     - OP Stack (Base): `remoteToken()(address)` and `bridge()(address)`, which must be `0x4200000000000000000000000000000000000010`.
     - Arbitrum: `l1Address()(address)` and `l2Gateway()(address)`.
   - Establish every power over the token (see [Detecting proxies](#detecting-proxies)), and check for `owner()`, `paused()`, `pauser()`, `blacklister()`, `minter()` or `getMinters()`, and `maxSupply()`.

   If any check disagrees, or you have only one source, do not list the token.

3. **Add the entry** with:
   - `chain`;
   - `address`: lowercase on EVM;
   - `symbol`: the on-chain symbol, or a plain ASCII form of it with `onchainSymbol` set to the on-chain value (for example `USDT0` and `USD₮0`);
   - `name`: the on-chain name;
   - `decimals`;
   - `tags`: `stablecoin` for stablecoins and `bridged` for canonical-bridge tokens;
   - `bridge`: the L1 address and gateway, for canonical-bridge tokens;
   - `bridgeExemption`, only for a `bridged` token whose gateway has no standard link to check (Arbitrum DAI today): a written `reason` and the gateway as `ward`. `verify:tokens` then checks `wards(ward)` is 1 on the token. Neither field is served to clients.
4. **Stablecoins change fees.** Tagging a token `stablecoin` requires adding it to `stablecoins` in `registry.ts` too, keyed by its symbol, and the reverse; a test enforces that the two are equal. That is fee data (spec section 2): it needs an owner decision and fee tests with exact expected values in `packages/fees`.
5. **Add a row to the risk table above**, with sources, powers and the decision.
6. **Run the checks:**

   ```sh
   pnpm --filter @ranvier/chains test
   pnpm --filter @ranvier/chains verify:tokens   # required; needs the network
   ```

   The unit tests check:
   - addresses are lowercase and unique;
   - symbols are unique;
   - each chain has exactly one native entry;
   - every `bridged` token has a `bridge` link or a `bridgeExemption`, never both;
   - the `stablecoin` tags equal the registry allowlist;
   - `knownDecimals` equals the list;
   - the list and the chain registry are frozen.

   `verify:tokens` first checks that each chain's RPC reports that chain's ID (`eth_chainId`); on a mismatch every token of the chain fails, because cbBTC has one address on three chains and would otherwise pass on the wrong one. It then reads every token's on-chain metadata, its bridge link or exemption ward, and its DefiLlama entry. It must print `N/N tokens verified` and exit 0. Paste its output into the PR.

7. **Update the [depth table](#depth-on-each-chain)** with the token's on-chain total supply.

8. Send the PR to the security reviewer.

## Detecting proxies

Read these storage slots with `cast storage <address> <slot> --rpc-url <rpc>`. A non-zero value means the token is upgradeable by whoever controls it.

| Slot                                                                 | Meaning                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` | EIP-1967 implementation                                    |
| `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103` | EIP-1967 admin                                             |
| `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50` | EIP-1967 **beacon**                                        |
| `0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3` | ZeppelinOS implementation (USDC and cbBTC FiatToken proxy) |
| `0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b` | ZeppelinOS admin                                           |

**Beacon proxies hide from the implementation-slot check.** Arbitrum's bridged tokens (WBTC, LINK, UNI) read zero in the EIP-1967 implementation and admin slots: they are beacon proxies. The beacon slot holds the beacon, `0xe72ba9418b5f2ce0a6a40501fe77c6839aa37333` when checked. Read its `implementation()` and `owner()`. Arbitrum standard-gateway tokens are also recognisable by `l1Address()` and `l2Gateway()`. Always read all five slots, not just the first.

A token with no proxy can still hold powers (owner pause, minters), so check the functions listed in step 2 too.

## Removing a token (routine)

1. Delete the entry and its risk-table row, and run the tests and `verify:tokens`.
2. If the token is a registry stablecoin or wrapped native, the tests fail. Removing a stablecoin also removes it from the fee allowlist, which is an owner decision with fee tests.
3. Open a PR and send it to the security reviewer.

Removing a token only hides it from the picker and drops its checked-in decimals. Users can still quote it by address, with decimals from DefiLlama alone (ADR 0004).

## Emergency delisting

Use this when a listed token is exploited, paused, rugged, starts charging a transfer fee, or is found to be the wrong contract.

1. **Remove the entry** from `TOKEN_LIST` in a PR titled `fix(chains): delist <SYMBOL> on <chain>`. If it is a stablecoin, also remove it from `stablecoins` in `registry.ts` in the same PR. Give the reason and a link to the evidence.
2. **Review.** The security reviewer approves with priority. CI must stay green; never skip it.
3. **Deploy the API and the web app.** Both bundle `@ranvier/chains`.
4. **Wait out caches.** List responses are `Cache-Control: private, max-age=300`, so browsers may keep them for 5 minutes and no shared cache should hold them. If a CDN is ever put in front of the API, it must key on `Origin` or bypass caching for `/v1/*`; purge `/v1/tokens*` there.
5. **If quotes must also stop** for the token, not just its listing, that is a separate change in the quote path (a denylist does not exist yet). Escalate to the security reviewer. Meanwhile the wrapper's on-chain checks still protect users:
   - fee-on-transfer swaps revert;
   - the output minimum is enforced.
6. Record the incident and the follow-up in the PR.

## Release checklist

Before every release of the API or the web app:

- [ ] `pnpm --filter @ranvier/chains verify:tokens` prints `N/N tokens verified` and exits 0. Any mismatch blocks the release until it is understood and the list is fixed.
- [ ] Issuer announcements checked for the listed tokens: migrations (for example a bridged token replaced by a native issue), pauses, or new fee switches.
- [ ] The risk table still matches `TOKEN_LIST`.

`verify:tokens` reads RPC URLs from `VERIFY_RPC_EVM_<chainId>` (for example `VERIFY_RPC_EVM_1`) and defaults to public publicnode endpoints. It validates each URL before any request and refuses a malformed or non-http(s) one with a message that names the variable but not its value. It never prints the URLs: any URL-looking text in an error is replaced with `<rpc-url>`. Never commit a keyed RPC URL.

import { buildRoutePolicy, type RoutePolicy, type TrustedRouter } from './domain/route-policy.js';

/**
 * 0x AllowanceHolder on Cancun-enabled chains (the same address everywhere). The fee wrapper
 * approves and calls this contract, so it must also be on the wrapper's on-chain allowlist.
 */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';

/**
 * 0x Settler instances accepted as the AllowanceHolder `target`, per chain: the current
 * taker-submitted Settler and the previous one (0x keeps serving the previous one while a new
 * deployment dwells). Read from the 0x Deployer registry
 * (0x00000000000004533Fe15556B1E086BB1A72cEae) with `ownerOf(2)` and `prev(2)` on 2026-10-12.
 *
 * Fails closed: when 0x rotates Settlers, quotes for the new one are refused until this list
 * is updated. Update it deliberately, through a reviewed PR, following
 * docs/runbooks/zerox-settler-rotation.md (ADR 0004).
 */
export const ZEROX_SETTLERS: Readonly<Record<number, readonly string[]>> = {
  // Ethereum
  1: ['0x0cef320d0c5793ade37964e2661a033771e53cd5', '0x666fedd4cdd4e890a5ad20e7b60975409435a64a'],
  // Base
  8453: [
    '0x7d6839415693801e94cdc4a7d732c9a3fdbbd1d7',
    '0x4f6f91599858bf0d19fabcf2c5d591fe13f7c059',
  ],
  // Arbitrum One
  42161: [
    '0x93ea5e32e9c2be78a279be03f86b74917537df51',
    '0xdbcd6d6e3e6ff51648ca73d4274cafd34d22a679',
  ],
};

function zeroXRouters(): Record<number, readonly TrustedRouter[]> {
  return Object.fromEntries(
    Object.entries(ZEROX_SETTLERS).map(([chainId, targets]) => [
      chainId,
      [{ kind: 'zerox-allowance-holder', address: ZEROX_ALLOWANCE_HOLDER, targets }],
    ]),
  );
}

/** Routers whose calldata the API will sign quotes for. Anything else is refused. */
export const TRUSTED_ROUTERS: RoutePolicy = buildRoutePolicy(zeroXRouters());

/** How the domain checks a router's calldata before a quote for it is signed. */
export type RouterKind = 'zerox-allowance-holder';

/**
 * A router the fee wrapper may call, and the only contracts its calldata may hand the
 * user's input to. Addresses are lowercase.
 */
export interface TrustedRouter {
  kind: RouterKind;
  address: string;
  /** For AllowanceHolder: the 0x Settler instances accepted as `operator` and `target`. */
  targets: readonly string[];
}

/** Trusted routers per EVM chain ID. A chain or router that is not listed is refused. */
export type RoutePolicy = ReadonlyMap<number, readonly TrustedRouter[]>;

export function trustedRouter(
  policy: RoutePolicy,
  chainId: number,
  address: string,
): TrustedRouter | undefined {
  const wanted = address.toLowerCase();
  return policy.get(chainId)?.find((r) => r.address === wanted);
}

/** Builds a policy, lowercasing addresses and rejecting malformed or empty entries. */
export function buildRoutePolicy(
  entries: Readonly<Record<number, readonly TrustedRouter[]>>,
): RoutePolicy {
  const isAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);
  const policy = new Map<number, readonly TrustedRouter[]>();
  for (const [chainId, routers] of Object.entries(entries)) {
    policy.set(
      Number(chainId),
      routers.map((r) => {
        if (!isAddress(r.address) || r.targets.length === 0 || !r.targets.every(isAddress)) {
          throw new Error(`invalid trusted router entry for chain ${chainId}`);
        }
        return {
          kind: r.kind,
          address: r.address.toLowerCase(),
          targets: r.targets.map((t) => t.toLowerCase()),
        };
      }),
    );
  }
  return policy;
}

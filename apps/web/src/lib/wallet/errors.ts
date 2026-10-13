export type WalletErrorKind = 'rejected' | 'pending' | 'other';

/**
 * Sorts a wallet or wagmi error into what the user needs to hear. Only well-known codes are read
 * (EIP-1193 4001 user rejected, -32002 request already pending, viem/wagmi error names); the
 * error text itself is provider-supplied and is never shown.
 */
export function classifyWalletError(error: unknown): WalletErrorKind {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const { code, name, cause } = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (name === 'UserRejectedRequestError') {
      // wagmi wraps a failed "add network" attempt in this error too: only the wallet's own 4001
      // (or no code at all) means the user said no.
      const inner = (cause as { code?: unknown } | undefined)?.code;
      return typeof inner === 'number' && inner !== 4001 ? 'other' : 'rejected';
    }
    if (code === 4001) return 'rejected';
    if (code === -32002 || name === 'ResourceUnavailableRpcError') return 'pending';
    current = cause;
  }
  return 'other';
}

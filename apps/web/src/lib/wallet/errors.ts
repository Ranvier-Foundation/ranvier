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
    if (code === 4001 || name === 'UserRejectedRequestError') return 'rejected';
    if (code === -32002 || name === 'ResourceUnavailableRpcError') return 'pending';
    current = cause;
  }
  return 'other';
}

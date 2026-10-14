/** Longest search text the API accepts (`MAX_TOKEN_QUERY_LENGTH` in apps/api). */
export const MAX_QUERY_LENGTH = 64;

/** The API's allowed characters: letters, digits, currency signs, spaces, `.`, `_` and `-`. */
const SEARCHABLE = /^[\p{L}\p{N}\p{Sc} ._-]*$/u;

export interface NormalisedQuery {
  /** Trimmed text to send. */
  query: string;
  /**
   * False when the text could not match any token (too long, or characters the API refuses) or
   * must not be sent (it holds the connected wallet's address).
   * The picker then shows "no match" without a request, instead of an error the user did not cause.
   */
  searchable: boolean;
}

/**
 * True when the text contains the connected wallet's address (40 hex digits, with or without
 * `0x`, in any case). The search text goes into a `/v1/tokens` URL, which is logged and cached
 * more widely than a request body, so the user's own address is never sent that way (ADR 0010).
 */
function containsWallet(query: string, walletAddress: string | undefined): boolean {
  if (walletAddress === undefined) return false;
  const hex = walletAddress.toLowerCase().replace(/^0x/, '');
  return hex.length > 0 && query.toLowerCase().includes(hex);
}

export function normaliseQuery(raw: string, walletAddress?: string): NormalisedQuery {
  const query = raw.trim();
  return {
    query,
    searchable:
      query.length <= MAX_QUERY_LENGTH &&
      SEARCHABLE.test(query) &&
      !containsWallet(query, walletAddress),
  };
}

/** Longest search text the API accepts (`MAX_TOKEN_QUERY_LENGTH` in apps/api). */
export const MAX_QUERY_LENGTH = 64;

/** The API's allowed characters: letters, digits, currency signs, spaces, `.`, `_` and `-`. */
const SEARCHABLE = /^[\p{L}\p{N}\p{Sc} ._-]*$/u;

export interface NormalisedQuery {
  /** Trimmed text to send. */
  query: string;
  /**
   * False when the text could not match any token (too long, or characters the API refuses).
   * The picker then shows "no match" without a request, instead of an error the user did not cause.
   */
  searchable: boolean;
}

export function normaliseQuery(raw: string): NormalisedQuery {
  const query = raw.trim();
  return { query, searchable: query.length <= MAX_QUERY_LENGTH && SEARCHABLE.test(query) };
}

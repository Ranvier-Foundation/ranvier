/**
 * Wallets announced through EIP-6963 are untrusted input: any script on the page can announce
 * one. Everything a wallet supplies (name, rdns, uuid, icon) is validated here before it is
 * shown. Nothing is rendered as HTML; icons only ever go into an <img>.
 */
export const MAX_WALLETS = 8;
export const MAX_NAME_LENGTH = 40;
/** Longest rdns hint shown under a name. */
export const MAX_HINT_LENGTH = 32;
/** Largest accepted icon, in characters of the data URI. */
export const MAX_ICON_LENGTH = 65_536;

/**
 * What the sanitiser reads from a wagmi connector. Typed as strings, but at run time these come
 * from a page script and may be anything (objects with a `toString` that changes, getters,
 * Proxies), so every field is read once, checked with `typeof`, and only the checked primitive
 * is used afterwards.
 */
export interface ConnectorLike {
  readonly id: string;
  readonly name: string;
  readonly icon?: string | undefined;
  readonly uid: string;
  readonly type: string;
}

export interface WalletOption<C extends ConnectorLike = ConnectorLike> {
  /** Stable key for lists (the lowercased rdns). */
  readonly key: string;
  readonly name: string;
  /** A safe `data:` image URI, or undefined (show the initial instead). */
  readonly icon: string | undefined;
  /**
   * Shown under the name when another listed wallet has the same name: the rdns, as text, so two
   * look-alike rows can be told apart. Undefined when the name is unique.
   */
  readonly hint: string | undefined;
  readonly connector: C;
}

const RDNS = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i;
const ICON = /^data:image\/(?:png|svg\+xml|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Control characters and line or paragraph separators: become a space. */
const SPACE_LIKE = new RegExp('[\\p{Cc}\\p{Zl}\\p{Zp}]', 'gu');
/**
 * Invisible and formatting characters: removed. Format characters (\p{Cf}: zero-width, bidi
 * controls, soft hyphen, word joiner, tag characters), the Mongolian vowel separator, Hangul
 * fillers (blank-looking letters), variation selectors and tag characters.
 */
const INVISIBLE = new RegExp(
  // eslint-disable-next-line no-misleading-character-class -- removing combining marks is the point
  '[\\p{Cf}\\u00ad\\u061c\\u180e\\u2060-\\u2064\\u115f\\u1160\\u3164\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}\\u{e0000}-\\u{e007f}]',
  'gu',
);
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/** The icon if it is a small base64 png, svg or webp data image, else undefined. */
export function safeIcon(icon: unknown): string | undefined {
  if (typeof icon !== 'string') return undefined;
  const value = icon;
  if (value.length === 0 || value.length > MAX_ICON_LENGTH) return undefined;
  return ICON.test(value) ? value : undefined;
}

/**
 * Cleans a wallet name: NFKC-normalised, control characters to spaces, invisible characters
 * removed, whitespace collapsed, at most MAX_NAME_LENGTH characters. Returns '' (so the wallet is
 * dropped) for a non-string or when no letter or digit is left, which also catches names made
 * only of blank-looking characters.
 */
export function safeName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const cleaned = name
    .normalize('NFKC')
    .replace(SPACE_LIKE, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!HAS_LETTER_OR_NUMBER.test(cleaned)) return '';
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
}

/** Same name for the purpose of spotting look-alikes. */
function foldName(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

/** A reverse-DNS id cut to a length that fits a row. */
function shortRdns(rdns: string): string {
  return rdns.length > MAX_HINT_LENGTH ? `${rdns.slice(0, MAX_HINT_LENGTH - 1)}…` : rdns;
}

/**
 * Turns connectors into the list the dialog shows: only EIP-6963 ones (their id is the rdns),
 * with a valid rdns and a name with a letter or digit in it, the first announcement of each rdns
 * kept, at most MAX_WALLETS, sorted by name. Wallets that share a name show their rdns so
 * look-alikes can be told apart. Every provider-supplied field is read once and must be a string.
 */
export function listWallets<C extends ConnectorLike>(connectors: readonly C[]): WalletOption<C>[] {
  const seen = new Set<string>();
  const seenUid = new Set<string>();
  const found: Omit<WalletOption<C>, 'hint'>[] = [];
  for (const connector of connectors) {
    const type: unknown = connector.type;
    const id: unknown = connector.id;
    const rawName: unknown = connector.name;
    const rawIcon: unknown = connector.icon;
    const uid: unknown = connector.uid;
    if (type !== 'injected' || typeof id !== 'string' || typeof uid !== 'string') continue;
    if (id.length > 253 || !RDNS.test(id)) continue;
    const key = id.toLowerCase();
    const name = safeName(rawName);
    if (!name || seen.has(key) || seenUid.has(uid)) continue;
    seen.add(key);
    seenUid.add(uid);
    found.push({ key, name, icon: safeIcon(rawIcon), connector });
  }
  const perName = new Map<string, number>();
  for (const w of found) perName.set(foldName(w.name), (perName.get(foldName(w.name)) ?? 0) + 1);
  const out: WalletOption<C>[] = found.map((w) => ({
    ...w,
    hint: (perName.get(foldName(w.name)) ?? 0) > 1 ? shortRdns(w.key) : undefined,
  }));
  out.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.key.localeCompare(b.key, 'en'));
  return out.slice(0, MAX_WALLETS);
}

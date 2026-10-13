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
 * Invisible, blank-looking and formatting characters: removed. That is everything Unicode marks
 * as default-ignorable (zero-width and bidi controls, soft hyphen, word joiner, combining grapheme
 * joiner U+034F, Mongolian free variation selectors, Hangul fillers, variation selectors, tag
 * characters), all format characters (\p{Cf}), private-use characters (\p{Co}, which render as
 * nothing or as a box), the Braille blank U+2800, and the conjoining Hangul jamo blocks (valid
 * jamo sequences are already composed into syllables by NFKC; what is left is a blank-looking
 * leftover such as U+115A).
 */
const INVISIBLE = new RegExp(
  '[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Co}\\u2800\\u00ad\\u061c\\u180e\\u1100-\\u11ff\\ua960-\\ua97f\\ud7b0-\\ud7ff]',
  'gu',
);
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
/** Most combining marks kept in a row; more is "zalgo" text. */
const MAX_MARKS_IN_A_ROW = 3;

/** The icon if it is a small base64 png, svg or webp data image, else undefined. */
export function safeIcon(icon: unknown): string | undefined {
  if (typeof icon !== 'string') return undefined;
  const value = icon;
  if (value.length === 0 || value.length > MAX_ICON_LENGTH) return undefined;
  return ICON.test(value) ? value : undefined;
}

/** Drops combining marks beyond MAX_MARKS_IN_A_ROW in a row. */
function capMarks(text: string): string {
  let run = 0;
  let out = '';
  for (const ch of text) {
    run = /^\p{M}$/u.test(ch) ? run + 1 : 0;
    if (run <= MAX_MARKS_IN_A_ROW) out += ch;
  }
  return out;
}

/**
 * Cleans a wallet name: NFKC-normalised, control characters to spaces, invisible characters
 * removed, whitespace collapsed, combining marks with nothing to attach to dropped and long runs
 * of marks cut, then cut to MAX_NAME_LENGTH characters. Only then is it checked: a name with no
 * letter or digit left (including one that was only blank-looking, or that truncation reduced to
 * bare marks) gives '' so the wallet is dropped. A non-string gives ''.
 */
export function safeName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const cleaned = capMarks(
    name
      .normalize('NFKC')
      .replace(SPACE_LIKE, ' ')
      .replace(INVISIBLE, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(^|\s)\p{M}+/gu, '$1'),
  );
  const cut = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
  return HAS_LETTER_OR_NUMBER.test(cut) ? cut : '';
}

/**
 * What a name looks like once spacing, punctuation, case and width are ignored: two wallets whose
 * skeletons are equal read the same to a person ("MetaMask", "Meta Mask", "METAMASK.").
 * Homoglyphs from other scripts (a Cyrillic "a") are not folded: a documented limit.
 */
export function nameSkeleton(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** A reverse-DNS id cut to a length that fits a row. */
function shortRdns(rdns: string): string {
  return rdns.length > MAX_HINT_LENGTH ? `${rdns.slice(0, MAX_HINT_LENGTH - 1)}…` : rdns;
}

/**
 * Turns connectors into the list the dialog shows: only EIP-6963 ones (their id is the rdns),
 * with a valid rdns and a name with a letter or digit in it, the first announcement of each rdns
 * kept. The cap is applied in announcement order: the FIRST MAX_WALLETS valid wallets are kept,
 * so a script that announces many wallets after the real ones cannot push them out; later
 * wallets are not shown. The kept wallets are then sorted by name for display. Wallets whose
 * name skeletons collide show their rdns so look-alikes can be told apart. Every
 * provider-supplied field is read once and must be a string.
 */
export function listWallets<C extends ConnectorLike>(connectors: readonly C[]): WalletOption<C>[] {
  const seen = new Set<string>();
  const seenUid = new Set<string>();
  const found: Omit<WalletOption<C>, 'hint'>[] = [];
  for (const connector of connectors) {
    if (found.length >= MAX_WALLETS) break;
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
  const perSkeleton = new Map<string, number>();
  for (const w of found) {
    const k = nameSkeleton(w.name);
    perSkeleton.set(k, (perSkeleton.get(k) ?? 0) + 1);
  }
  const out: WalletOption<C>[] = found.map((w) => ({
    ...w,
    hint: (perSkeleton.get(nameSkeleton(w.name)) ?? 0) > 1 ? shortRdns(w.key) : undefined,
  }));
  out.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.key.localeCompare(b.key, 'en'));
  return out;
}

/**
 * Wallets announced through EIP-6963 are untrusted input: any script on the page can announce
 * one. Everything a wallet supplies (name, rdns, uuid, icon) is validated here before it is
 * shown. Nothing is rendered as HTML; icons only ever go into an <img>.
 */
export const MAX_WALLETS = 8;
export const MAX_NAME_LENGTH = 40;
/** Largest accepted icon, in characters of the data URI. */
export const MAX_ICON_LENGTH = 65_536;

/** What the sanitiser needs from a wagmi connector. */
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
  readonly connector: C;
}

const RDNS = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i;
const ICON = /^data:image\/(?:png|svg\+xml|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function safeIcon(icon: string | undefined): string | undefined {
  if (!icon || icon.length > MAX_ICON_LENGTH) return undefined;
  return ICON.test(icon) ? icon : undefined;
}

/** Strips control and bidi-override characters, collapses whitespace and caps the length. */
export function safeName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
}

/**
 * Turns connectors into the list the dialog shows: only EIP-6963 ones (their id is the rdns),
 * with a valid rdns and a non-empty name, duplicates dropped (same rdns or same uid), at most
 * MAX_WALLETS, sorted by name so a page cannot push itself to the top by announcing first.
 */
export function listWallets<C extends ConnectorLike>(connectors: readonly C[]): WalletOption<C>[] {
  const seen = new Set<string>();
  const seenUid = new Set<string>();
  const out: WalletOption<C>[] = [];
  for (const connector of connectors) {
    if (connector.type !== 'injected' || !RDNS.test(connector.id) || connector.id.length > 253) {
      continue;
    }
    const key = connector.id.toLowerCase();
    const name = safeName(String(connector.name ?? ''));
    if (!name || seen.has(key) || seenUid.has(connector.uid)) continue;
    seen.add(key);
    seenUid.add(connector.uid);
    out.push({ key, name, icon: safeIcon(connector.icon), connector });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.key.localeCompare(b.key, 'en'));
  return out.slice(0, MAX_WALLETS);
}

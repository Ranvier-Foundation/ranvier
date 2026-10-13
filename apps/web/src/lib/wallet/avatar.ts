/**
 * Wallet avatar: four quadrants (top-left, top-right, bottom-left, bottom-right), each one of a
 * few design tokens, derived from the address. Pure and deterministic; only token names leave
 * this module (components turn them into token utility classes), so no raw colour can appear.
 */
export const AVATAR_TOKENS = ['primary', 'blush', 'accent', 'deep-tile'] as const;
export type AvatarToken = (typeof AVATAR_TOKENS)[number];
export type AvatarQuadrants = readonly [AvatarToken, AvatarToken, AvatarToken, AvatarToken];

/** The canvas avatar, used when the address is not a valid EVM address. */
export const DEFAULT_QUADRANTS: AvatarQuadrants = ['primary', 'blush', 'blush', 'accent'];

function tokenAt(index: number): AvatarToken {
  return AVATAR_TOKENS[index % AVATAR_TOKENS.length] ?? 'primary';
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function avatarQuadrants(address: string): AvatarQuadrants {
  if (!ADDRESS.test(address)) return DEFAULT_QUADRANTS;
  // Fold the 20 bytes into four accumulators so every byte influences the result.
  const acc = [7, 7, 7, 7];
  for (let i = 0; i < 20; i++) {
    const byte = parseInt(address.slice(2 + i * 2, 4 + i * 2), 16);
    acc[i % 4] = ((acc[i % 4] ?? 7) * 31 + byte) >>> 0;
  }
  const pick = (n: number): AvatarToken => tokenAt((acc[n] ?? 0) % AVATAR_TOKENS.length);
  const q: [AvatarToken, AvatarToken, AvatarToken, AvatarToken] = [
    pick(0),
    pick(1),
    pick(2),
    pick(3),
  ];
  // Four identical quadrants would read as a flat disc: step the last one to the next token.
  if (q.every((t) => t === q[0])) {
    q[3] = tokenAt(AVATAR_TOKENS.indexOf(q[0]) + 1);
  }
  return q;
}

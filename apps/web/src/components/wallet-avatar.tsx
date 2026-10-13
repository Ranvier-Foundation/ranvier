import { avatarQuadrants, type AvatarToken } from '@/lib/wallet/avatar';

/** Token to utility class. Literal strings so Tailwind sees every class. */
const FILL: Record<AvatarToken, string> = {
  primary: 'bg-primary',
  blush: 'bg-blush',
  accent: 'bg-accent',
  'deep-tile': 'bg-deep-tile',
};

/** 30 px round wallet avatar: four quadrants chosen from the address (see `avatarQuadrants`). */
export function WalletAvatar({ address }: { address: string }) {
  const quadrants = avatarQuadrants(address);
  return (
    <span aria-hidden="true" className="grid size-avatar grid-cols-2 overflow-hidden rounded-round">
      {quadrants.map((token, i) => (
        <span key={i} className={FILL[token]} />
      ))}
    </span>
  );
}

import type { Me } from '@spinroom/contracts';
import s from './UserMenu.module.css';

/** First letter of the first name ("David Smith" → "D"); emoji-safe; "?" if there's nothing usable. */
export function initialOf(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0] ?? '';
  const ch = Array.from(first)[0];
  return ch ? ch.toLocaleUpperCase() : '?';
}

/** Round profile picture: the uploaded photo, or a coloured circle with the initial. */
export function UserBadge({ me, size = 36 }: { me: Pick<Me, 'displayName' | 'photoUrl' | 'avatarColor'>; size?: number }) {
  return me.photoUrl ? (
    <img className={s.badge} src={me.photoUrl} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span
      className={`${s.badge} ${s.initial}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background: me.avatarColor }}
      aria-hidden="true"
      data-testid="user-initial"
    >
      {initialOf(me.displayName)}
    </span>
  );
}

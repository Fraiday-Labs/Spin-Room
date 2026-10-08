import type { Avatar, Me } from '@spinroom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { AvatarSprite } from '../room/AvatarSprite';
import s from './AvatarPicker.module.css';

/** Presets plus my custom avatars (FR-A11: switch any time). */
export function AvatarPicker({ me, onError }: { me: Me; onError?: (m: string) => void }) {
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['avatars', 'presets'], queryFn: () => api.call('avatars.presets') });
  const mine = useQuery({ queryKey: ['avatars', 'mine'], queryFn: () => api.call('avatars.mine') });
  const choose = async (a: Avatar) => {
    try {
      qc.setQueryData(['me'], await api.call('me.setAvatar', { body: { avatarId: a.id } }));
    } catch (e) {
      onError?.(errorMessage(e));
    }
  };
  // Defaults first (built-in, then ones a site admin offers), then my own uploads.
  const defaults = presets.data ?? [];
  const all = [...defaults, ...(mine.data ?? []).filter((a) => a.status !== 'rejected' && !defaults.some((d) => d.id === a.id))];
  return (
    <div className={s.grid} role="radiogroup" aria-label="Avatar">
      {all.map((a) => (
        <button key={a.id} role="radio" aria-checked={me.avatar.id === a.id} className={s.opt} onClick={() => void choose(a)} title={a.name}>
          <AvatarSprite avatar={a} state={me.avatar.id === a.id ? 'wave' : 'idle'} width={64} />
          <span className={s.name}>{a.name}</span>
          {a.status === 'pending' && <span className="badge badge-warn">in review</span>}
        </button>
      ))}
    </div>
  );
}

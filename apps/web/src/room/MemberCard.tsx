import type { Me, Member, RoomSnapshot } from '@spinroom/contracts';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { AvatarSprite } from './AvatarSprite';
import s from './MemberCard.module.css';

/** Hover/click card: front-facing avatar, points, presence, report and moderation. */
export function MemberCard({
  member,
  snap,
  me,
  onClose,
  notify,
}: {
  member: Member;
  snap: RoomSnapshot;
  me: Me | null;
  onClose: () => void;
  notify: (m: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const myRole = snap.me?.role;
  const isMod = myRole === 'owner' || myRole === 'moderator';
  const canModerate = isMod && member.user.id !== me?.id && member.role !== 'owner' && (myRole === 'owner' || member.role !== 'moderator');
  const mod = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      await api.call('rooms.moderate', { params: { slug: snap.room.slug }, body: { action: action as never, userId: member.user.id, ...extra } });
      notify('Done');
      onClose();
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  return (
    <dialog ref={ref} className={s.card} onClose={onClose} aria-labelledby="member-name">
      <div className={s.head}>
        <AvatarSprite avatar={member.user.avatar} state="wave" width={96} />
        <div>
          <h2 id="member-name">{member.user.displayName}</h2>
          <div className="row">
            <span className="badge">{member.role}</span>
            <span className="badge">{member.presence === 'speaker' ? 'listening' : member.presence === 'remote' ? 'remote' : 'away'}</span>
            <span className="badge badge-ok">{member.user.points} pts</span>
          </div>
        </div>
      </div>
      {member.user.avatar.kind === 'custom' && member.user.id !== me?.id && (
        <div className="stack">
          {!reporting ? (
            <button className="btn btn-ghost" onClick={() => setReporting(true)}>
              Report avatar
            </button>
          ) : (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api.call('avatars.report', { params: { id: member.user.avatar.id }, body: { reason, roomSlug: snap.room.slug } });
                  notify('Thanks — the avatar was sent for review.');
                  onClose();
                } catch (err) {
                  notify(errorMessage(err));
                }
              }}
            >
              <label className="field">
                What’s wrong with it?
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />
              </label>
              <button className="btn" type="submit">
                Send report
              </button>
            </form>
          )}
        </div>
      )}
      {canModerate && (
        <div className={s.mod}>
          <h3>Moderate</h3>
          <div className="row">
            <button className="btn" onClick={() => mod(member.muted ? 'unmute' : 'mute')}>
              {member.muted ? 'Unmute chat' : 'Mute chat'}
            </button>
            {member.user.avatar.kind === 'custom' || member.avatarHidden ? (
              <button className="btn" onClick={() => mod(member.avatarHidden ? 'unhide_avatar' : 'hide_avatar')}>
                {member.avatarHidden ? 'Show avatar' : 'Hide avatar here'}
              </button>
            ) : null}
            {snap.booth.some((b) => b.userId === member.user.id) && (
              <button className="btn" onClick={() => mod('remove_from_booth')}>
                Remove from booth
              </button>
            )}
            <button className="btn" onClick={() => mod('kick')}>
              Kick
            </button>
            <button className="btn" onClick={() => mod('ban')}>
              Ban
            </button>
            {myRole === 'owner' && (
              <button className="btn" onClick={() => mod('set_role', { role: member.role === 'moderator' ? 'member' : 'moderator' })}>
                {member.role === 'moderator' ? 'Remove moderator' : 'Make moderator'}
              </button>
            )}
          </div>
        </div>
      )}
      <form method="dialog">
        <button className="btn btn-ghost">Close</button>
      </form>
    </dialog>
  );
}

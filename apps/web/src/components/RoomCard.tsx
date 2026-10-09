import type { RoomSummary } from '@spinroom/contracts';
import { useState } from 'react';
import { Link } from 'wouter';
import { LineIcon } from './LineIcon';
import { OverflowMenu } from './OverflowMenu';
import s from './RoomCard.module.css';
import { RoomLifecycle } from './RoomLifecycle';

/** "3 here · 2 listening", leaving out anything that's zero. */
function headcount(r: RoomSummary) {
  return [r.listeners ? `${r.listeners} here` : null, r.liveSpeakers ? `${r.liveSpeakers} listening` : null].filter(Boolean).join(' · ');
}

/**
 * A room in the lobby.
 * - `live`: something is playing — big card with the track's art.
 * - `card`: one of your rooms, quiet right now.
 * - `quiet`: a compact row for public rooms with nothing on.
 * `manage`: Close / Delete in the card's "⋯" menu (rooms you own, or as a site admin).
 */
export function RoomCard({ room, manage = false, variant = 'card' }: { room: RoomSummary; manage?: boolean; variant?: 'live' | 'card' | 'quiet' }) {
  const [act, setAct] = useState<'close' | 'delete' | null>(null);
  const href = `/r/${room.slug}`;
  const count = headcount(room);
  const role = room.myRole && room.myRole !== 'member' ? <span className="badge">{room.myRole}</span> : null;
  const inviteOnly = room.visibility === 'invite_only' ? <span className="badge">Invite only</span> : null;

  // Closed rooms only show up in their owner's list, with a way to reopen or delete them.
  if (room.closedAt)
    return (
      <div className={`${s.card} ${s.closed}`} data-testid={`room-card-${room.slug}`}>
        <div className={s.top}>
          <h3 className={s.name}>{room.name}</h3>
          <span className="badge badge-warn">Closed</span>
        </div>
        {room.description && <p className={s.desc}>{room.description}</p>}
        <RoomLifecycle room={room} />
      </div>
    );

  if (variant === 'quiet')
    return (
      <Link href={href} className={s.quiet} data-testid={`room-card-${room.slug}`}>
        <span className={s.quietText}>
          <span className={s.quietName}>{room.name}</span>
          {room.description && <span className={s.quietDesc}>{room.description}</span>}
        </span>
        {inviteOnly}
        {count && <span className={s.quietCount}>{count}</span>}
        <span className={s.go}>
          {room.status === 'paused' ? 'Paused' : 'Start the music'}
          <LineIcon name="forward" size={14} />
        </span>
      </Link>
    );

  const np = room.nowPlaying;
  const body =
    variant === 'live' && np ? (
      <>
        {np.artUrl ? <img className={s.art} src={np.artUrl} alt="" loading="lazy" /> : <span className={`${s.art} ${s.artBlank}`} aria-hidden="true" />}
        <div className={s.liveInfo}>
          <span className={s.liveTag}>
            <span className={s.dot} aria-hidden="true" />
            Live{count && <span className={s.liveCount}> · {count}</span>}
          </span>
          <h3 className={s.name}>{room.name}</h3>
          <span className={s.track}>{np.title}</span>
          <span className={s.by}>
            {np.artists.join(', ')} <span className={s.dj}>· DJ {np.djName}</span>
          </span>
          {(inviteOnly || role) && (
            <span className={s.badges}>
              {inviteOnly}
              {role}
            </span>
          )}
        </div>
      </>
    ) : (
      <>
        <div className={s.top}>
          <h3 className={s.name}>{room.name}</h3>
          {inviteOnly}
        </div>
        {room.description && <p className={s.desc}>{room.description}</p>}
        <span className={s.meta}>
          <span>{room.status === 'paused' ? 'Paused' : 'Booth open — step up'}</span>
          {count && <span>{count}</span>}
          {role}
        </span>
      </>
    );
  const cls = `${s.card} ${variant === 'live' ? s.live : ''} ${manage ? s.hasMenu : ''}`;

  if (!manage)
    return (
      <Link href={href} className={cls} data-testid={`room-card-${room.slug}`}>
        {body}
      </Link>
    );
  // Owners (and site admins) get Close / Delete in a small menu on the card.
  return (
    <div className={cls} data-testid={`room-card-${room.slug}`}>
      <Link href={href} className={s.cardLink}>
        {body}
      </Link>
      <div className={s.menuSlot}>
        <OverflowMenu
          label={`Options for ${room.name}`}
          items={[
            { label: 'Close room', onSelect: () => setAct('close') },
            { label: 'Delete room', danger: true, onSelect: () => setAct('delete') },
          ]}
        />
      </div>
      {act && (
        <div className={s.manage}>
          <RoomLifecycle key={act} room={room} initial={act} onCancel={() => setAct(null)} />
        </div>
      )}
    </div>
  );
}

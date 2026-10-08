import type { RoomSummary } from '@spinroom/contracts';
import { Link } from 'wouter';
import s from './RoomCard.module.css';
import { RoomLifecycle } from './RoomLifecycle';

/** `manage`: show the owner's Close / Delete controls (used in My rooms). */
export function RoomCard({ room, manage = false }: { room: RoomSummary; manage?: boolean }) {
  // Closed rooms only show up in their owner's list, with a way to reopen or delete them.
  if (room.closedAt)
    return (
      <div className={s.card} style={{ opacity: 0.85 }}>
        <div className={s.top}>
          <h3 className={s.name}>{room.name}</h3>
          <span className="badge badge-warn">Closed</span>
        </div>
        {room.description && <p className={s.desc}>{room.description}</p>}
        <RoomLifecycle room={room} />
      </div>
    );
  const body = (
    <>
      <div className={s.top}>
        <h3 className={s.name}>{room.name}</h3>
        {room.visibility === 'invite_only' && <span className="badge">Invite only</span>}
      </div>
      {room.description && <p className={s.desc}>{room.description}</p>}
      <div className={s.now}>
        {room.nowPlaying ? (
          <>
            <span aria-hidden="true">♪ </span>
            {room.nowPlaying.artists.join(', ')} – {room.nowPlaying.title}
            <span className="muted"> · DJ {room.nowPlaying.djName}</span>
          </>
        ) : (
          <span className="muted">{room.status === 'paused' ? 'Paused' : 'Booth open — step up'}</span>
        )}
      </div>
      <div className={s.meta}>
        <span>{room.listeners} here</span>
        <span>{room.liveSpeakers} listening</span>
        {room.myRole && room.myRole !== 'member' && <span className="badge">{room.myRole}</span>}
      </div>
    </>
  );
  // Owners get Close / Delete right on the card in their own list.
  if (manage && room.myRole === 'owner')
    return (
      <div className={s.card} data-testid={`room-card-${room.slug}`}>
        <Link href={`/r/${room.slug}`} className={s.cardLink}>
          {body}
        </Link>
        <div className={s.manage}>
          <RoomLifecycle room={room} />
        </div>
      </div>
    );
  return (
    <Link href={`/r/${room.slug}`} className={s.card}>
      {body}
    </Link>
  );
}

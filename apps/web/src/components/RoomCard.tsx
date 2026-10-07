import type { RoomSummary } from '@spinroom/contracts';
import { Link } from 'wouter';
import s from './RoomCard.module.css';

export function RoomCard({ room }: { room: RoomSummary }) {
  return (
    <Link href={`/r/${room.slug}`} className={s.card}>
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
    </Link>
  );
}

import type { RoomSummary } from '@spinroom/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CreateRoomDialog } from '../components/CreateRoomDialog';
import { PageSkeleton } from '../components/PageSkeleton';
import { RoomTable } from '../components/RoomTable';
import { api, signInUrl, useMe } from '../lib/api';
import s from './Lobby.module.css';

/** Past this many quiet public rooms, the rest (the emptiest) wait behind "Show more rooms". */
const QUIET_SHOWN = 8;

const busiest = (a: RoomSummary, b: RoomSummary) => b.listeners - a.listeners || a.name.localeCompare(b.name);

export default function Lobby() {
  const me = useMe();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [showQuiet, setShowQuiet] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const mine = useQuery({ queryKey: ['rooms', 'mine'], queryFn: () => api.call('rooms.list', { query: { filter: 'mine', limit: 50 } }), enabled: !!me.data });
  const pub = useQuery({
    queryKey: ['rooms', 'public', debounced],
    queryFn: () => api.call('rooms.list', { query: { filter: 'public', q: debounced || undefined, limit: 30 } }),
  });
  const [creating, setCreating] = useState(false);

  if (me.isLoading) return <PageSkeleton cards={6} grid />;
  if (!me.data) {
    return (
      <div className="page stack">
        <h1>Rooms</h1>
        <a className="btn btn-spotify" href={signInUrl('/lobby')} style={{ justifySelf: 'start' }}>
          Sign in with Spotify
        </a>
      </div>
    );
  }
  const isAdmin = me.data.isAdmin;
  const needle = debounced.toLowerCase();
  const myRooms = (mine.data?.rooms ?? []).filter((r) => !needle || `${r.name} ${r.description}`.toLowerCase().includes(needle));
  const myIds = new Set(mine.data?.rooms.map((r) => r.id));
  const others = (pub.data?.rooms ?? []).filter((r) => !myIds.has(r.id));
  const isLive = (r: RoomSummary) => !r.closedAt && !!r.nowPlaying;
  const live = [...myRooms, ...others].filter(isLive).sort(busiest);
  const myRest = myRooms.filter((r) => !isLive(r));
  const quiet = others.filter((r) => !isLive(r)).sort(busiest);
  // With lots of quiet rooms, the busiest show (always every one with people in it) until asked.
  const folding = !needle && !showQuiet && quiet.length > QUIET_SHOWN;
  const quietShown = folding ? quiet.slice(0, Math.max(QUIET_SHOWN, quiet.filter((r) => r.listeners > 0).length)) : quiet;
  const folded = quiet.length - quietShown.length;
  const loaded = !mine.isLoading && !pub.isLoading;
  const manage = (r: RoomSummary) => myIds.has(r.id) && (r.myRole === 'owner' || isAdmin);

  return (
    <div className={`page stack ${s.page}`}>
      <header className={s.hdr}>
        <h1 className={s.hi}>Hey {me.data.displayName}</h1>
        <div className={s.tools}>
          <input
            className={`input ${s.search}`}
            type="search"
            placeholder="Search rooms"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search rooms"
          />
          <button className="btn btn-primary" style={{ flex: 'none' }} onClick={() => setCreating(true)} data-testid="open-create-room">
            Create +
          </button>
        </div>
      </header>

      {live.length > 0 && (
        <section className={s.section} aria-labelledby="live-now">
          <h2 id="live-now" className={s.h2}>
            Live now
          </h2>
          <RoomTable rooms={live} label="Live now" manage={manage} />
        </section>
      )}

      {(myRest.length > 0 || (!needle && mine.data && myRooms.length === 0)) && (
        <section className={s.section} aria-labelledby="your-rooms">
          <h2 id="your-rooms" className={s.h2}>
            Your rooms
          </h2>
          {myRooms.length === 0 ? (
            <p className="muted">You haven’t joined any rooms yet. Create one, or hop into a room below.</p>
          ) : (
            <RoomTable rooms={myRest} label="Your rooms" manage={manage} />
          )}
        </section>
      )}

      {quiet.length > 0 && (
        <section className={s.section} aria-labelledby="public-rooms">
          <h2 id="public-rooms" className={s.h2}>
            {live.length ? 'More public rooms' : 'Public rooms'}
          </h2>
          {quietShown.length > 0 && <RoomTable rooms={quietShown} label={live.length ? 'More public rooms' : 'Public rooms'} />}
          {folded > 0 && (
            <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setShowQuiet(true)}>
              Show {folded} more {folded === 1 ? 'room' : 'rooms'}
            </button>
          )}
        </section>
      )}

      {loaded && live.length + myRest.length + quiet.length === 0 && (needle || myRooms.length > 0) && (
        <p className="muted">{needle ? `No rooms match “${debounced}”.` : 'No public rooms yet — create the first one.'}</p>
      )}
      {creating && <CreateRoomDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

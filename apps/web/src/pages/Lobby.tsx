import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CreateRoomDialog } from '../components/CreateRoomDialog';
import { RoomCard } from '../components/RoomCard';
import { api, signInUrl, useMe } from '../lib/api';

export default function Lobby() {
  const me = useMe();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(h);
  }, [q]);
  const mine = useQuery({ queryKey: ['rooms', 'mine'], queryFn: () => api.call('rooms.list', { query: { filter: 'mine', limit: 50 } }), enabled: !!me.data });
  const pub = useQuery({
    queryKey: ['rooms', 'public', debounced],
    queryFn: () => api.call('rooms.list', { query: { filter: 'public', q: debounced || undefined, limit: 30 } }),
  });
  const [creating, setCreating] = useState(false);
  const remoteOnly = new URLSearchParams(location.search).get('remote_only') === '1';

  if (me.isLoading) return <div className="page muted">Loading…</div>;
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
  return (
    <div className="page stack">
      {(remoteOnly || me.data.remoteOnly) && (
        <div className="notice">
          Your Spotify account isn’t Premium, so you’re a <b>remote</b>: you can browse, chat and vote, but Spotify only lets Premium accounts play in a speaker
          tab or DJ.
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>Hey {me.data.displayName}</h1>
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <input
            className="input"
            style={{ width: 240, maxWidth: '45vw' }}
            type="search"
            placeholder="Search rooms"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search public rooms"
          />
          <button className="btn btn-primary" style={{ flex: 'none' }} onClick={() => setCreating(true)} data-testid="open-create-room">
            Create +
          </button>
        </div>
      </div>

      <section className="stack">
        <h2>My rooms</h2>
        {mine.data?.rooms.length === 0 && <p className="muted">You haven’t joined any rooms yet.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {mine.data?.rooms.map((r) => (
            <RoomCard key={r.id} room={r} manage={r.myRole === 'owner' || !!me.data?.isAdmin} />
          ))}
        </div>
      </section>

      <section className="stack">
        <h2 style={{ margin: 0 }}>Public rooms</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {pub.data?.rooms.map((r) => (
            <RoomCard key={r.id} room={r} />
          ))}
        </div>
        {pub.data?.rooms.length === 0 && <p className="muted">No public rooms match.</p>}
      </section>
      {creating && <CreateRoomDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

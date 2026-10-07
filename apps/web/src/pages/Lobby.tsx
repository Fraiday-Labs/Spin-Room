import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { AvatarPicker } from '../components/AvatarPicker';
import { RoomCard } from '../components/RoomCard';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';

export default function Lobby() {
  const me = useMe();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
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
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'invite_only'>('public');
  const [skipRatio, setSkipRatio] = useState(0.5);
  const [boothSlots, setBoothSlots] = useState(3);
  const [err, setErr] = useState<string | null>(null);
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
        <span className={me.data.isPremium ? 'badge badge-ok' : 'badge badge-warn'}>{me.data.isPremium ? 'Premium · can listen & DJ' : 'Remote only'}</span>
      </div>

      <section className="stack">
        <h2>My rooms</h2>
        {mine.data?.rooms.length === 0 && <p className="muted">You haven’t joined any rooms yet.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {mine.data?.rooms.map((r) => (
            <RoomCard key={r.id} room={r} />
          ))}
        </div>
      </section>

      <section className="card stack">
        <h2>Open a room</h2>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              const res = await api.call('rooms.create', { body: { name, visibility, settings: { skipRatio, boothSlots } } });
              await qc.invalidateQueries({ queryKey: ['rooms'] });
              navigate(`/r/${res.room.slug}`);
            } catch (e2) {
              setErr(errorMessage(e2));
            }
          }}
        >
          <label className="field">
            Room name
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={60}
              required
              placeholder="Friday Night Spins"
              data-testid="room-name"
            />
          </label>
          <div className="row">
            <label className="field">
              Who can join
              <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'invite_only')}>
                <option value="public">Public — listed in the directory</option>
                <option value="invite_only">Invite only</option>
              </select>
            </label>
            <label className="field">
              Auto-skip when Skip reaches
              <select className="input" value={skipRatio} onChange={(e) => setSkipRatio(Number(e.target.value))}>
                <option value={0.5}>50% of listeners</option>
                <option value={0.67}>Two thirds</option>
                <option value={0.75}>75%</option>
              </select>
            </label>
            <label className="field">
              Booth size
              <select className="input" value={boothSlots} onChange={(e) => setBoothSlots(Number(e.target.value))}>
                <option value={1}>1 DJ</option>
                <option value={2}>2 DJs</option>
                <option value={3}>3 DJs</option>
              </select>
            </label>
          </div>
          {err && <p className="error">{err}</p>}
          <button className="btn btn-primary" type="submit" style={{ justifySelf: 'start' }} data-testid="create-room">
            Create room
          </button>
        </form>
      </section>

      <section className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Public rooms</h2>
          <input
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="Search rooms"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search public rooms"
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          {pub.data?.rooms.map((r) => (
            <RoomCard key={r.id} room={r} />
          ))}
        </div>
        {pub.data?.rooms.length === 0 && <p className="muted">No public rooms match.</p>}
      </section>

      <section className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Your avatar</h2>
          <Link href="/profile/avatar">Make one from a ChatGPT pet →</Link>
        </div>
        <AvatarPicker me={me.data} />
      </section>
    </div>
  );
}

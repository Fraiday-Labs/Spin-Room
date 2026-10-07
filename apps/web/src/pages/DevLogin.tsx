import { useState } from 'react';

/** Fake-Spotify sign-in (SPOTIFY_MODE=fake only): pick a test identity. */
export function DevLogin() {
  const state = new URLSearchParams(location.search).get('state') ?? '';
  const [id, setId] = useState('');
  const [premium, setPremium] = useState(true);
  const go = (userId: string, isPremium = premium) => {
    location.href = `/v1/auth/spotify/callback?code=${encodeURIComponent(`${userId}.${isPremium ? 'premium' : 'free'}`)}&state=${encodeURIComponent(state)}`;
  };
  return (
    <div className="page stack" style={{ maxWidth: 520 }}>
      <h1>Test sign-in</h1>
      <p className="muted">Fake Spotify for local development. Pick a seeded user or type any ID.</p>
      <div className="row">
        {['alice', 'bob', 'carol'].map((u) => (
          <button key={u} className="btn" onClick={() => go(u, true)}>
            {u}
          </button>
        ))}
        <button className="btn" onClick={() => go('freddie-free', false)}>
          freddie (Free)
        </button>
      </div>
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (id.trim())
            go(
              id
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, '-'),
            );
        }}
      >
        <label className="field">
          Spotify user ID
          <input className="input" value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. dj-sam" />
        </label>
        <label className="row">
          <input type="checkbox" checked={premium} onChange={(e) => setPremium(e.target.checked)} /> Premium account
        </label>
        <button className="btn btn-primary" type="submit" disabled={!id.trim()}>
          Sign in
        </button>
      </form>
    </div>
  );
}

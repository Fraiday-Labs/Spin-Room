import { AVATAR_COLORS } from '@spinroom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'wouter';
import { AvatarPicker } from '../components/AvatarPicker';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';
import { AvatarSprite } from '../room/AvatarSprite';
import { AvatarStudio } from '../studio/AvatarStudio';

export default function Profile({ tab }: { tab?: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.call('tokens.list'), enabled: !!me.data });
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (me.isLoading) return <div className="page muted">Loading…</div>;
  if (!me.data)
    return (
      <a className="page btn btn-spotify" href={signInUrl()}>
        Sign in
      </a>
    );
  const u = me.data;
  return (
    <div className="page stack">
      <div className="row">
        <AvatarSprite avatar={u.avatar} state="wave" width={96} />
        <div className="stack" style={{ gap: 4 }}>
          <h1 style={{ margin: 0 }}>{u.displayName}</h1>
          <div className="row">
            <span className={u.isPremium ? 'badge badge-ok' : 'badge badge-warn'}>{u.isPremium ? 'Spotify Premium' : 'Remote only (Spotify Free)'}</span>
            <span className="badge">{u.points} DJ points</span>
          </div>
        </div>
      </div>
      <nav className="row" aria-label="Profile sections">
        <Link href="/profile" className={!tab ? 'btn btn-primary' : 'btn'}>
          Profile
        </Link>
        <Link href="/profile/avatar" className={tab === 'avatar' ? 'btn btn-primary' : 'btn'}>
          Avatar studio
        </Link>
      </nav>
      {tab === 'avatar' ? (
        <AvatarStudio me={u} />
      ) : (
        <>
          <section className="card stack">
            <h2>Display</h2>
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  qc.setQueryData(['me'], await api.call('me.patch', { body: { displayName: name ?? u.displayName } }));
                  setMsg('Saved.');
                } catch (err) {
                  setMsg(errorMessage(err));
                }
              }}
            >
              <label className="field">
                Display name
                <input className="input" value={name ?? u.displayName} maxLength={40} onChange={(e) => setName(e.target.value)} />
              </label>
              <button className="btn" type="submit" style={{ alignSelf: 'end' }}>
                Save
              </button>
            </form>
            <div className="stack">
              <span className="muted">Crowd color</span>
              <div className="row" role="radiogroup" aria-label="Crowd color">
                {AVATAR_COLORS.map((c) => (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={u.avatarColor.toUpperCase() === c.toUpperCase()}
                    aria-label={c}
                    onClick={async () => qc.setQueryData(['me'], await api.call('me.patch', { body: { avatarColor: c } }))}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 6,
                      background: c,
                      border: u.avatarColor.toUpperCase() === c.toUpperCase() ? '3px solid white' : '2px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </div>
            {msg && <p role="status">{msg}</p>}
          </section>

          <section className="card stack">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Your avatar</h2>
              <Link href="/profile/avatar">Make one from a ChatGPT pet →</Link>
            </div>
            <AvatarPicker me={u} />
          </section>

          <section className="card stack">
            <h2>Connections</h2>
            <p>
              Spotify: <b>{u.spotifyUserId}</b>
              {u.spotifyClientId && <span className="muted"> · via Client ID {u.spotifyClientId.slice(0, 6)}…</span>}
            </p>
            <p>
              Slack: {u.connections.slack ? 'linked' : 'not linked'}
              {u.connections.slack && (
                <button
                  className="btn btn-ghost"
                  onClick={async () => {
                    await api.call('me.unlinkIdentity', { params: { provider: 'slack' } });
                    await qc.invalidateQueries({ queryKey: ['me'] });
                  }}
                >
                  Unlink
                </button>
              )}
            </p>
            <div className="stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>Coding agents (MCP)</span>
                <Link href="/connect-agent">Connect an agent →</Link>
              </div>
              <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                {tokens.data
                  ?.filter((t) => !t.revokedAt)
                  .map((t) => (
                    <li key={t.id} className="row">
                      <span>{t.label}</span>
                      <span className="muted">{t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}</span>
                      <button
                        className="btn btn-ghost"
                        onClick={async () => {
                          await api.call('tokens.revoke', { params: { id: t.id } });
                          await tokens.refetch();
                        }}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          </section>

          <section className="card stack">
            <h2>Delete account</h2>
            <p className="muted">Removes your profile, sets, tokens and connections now; remaining personal data is purged within 30 days.</p>
            <button
              className="btn"
              style={{ justifySelf: 'start', borderColor: 'var(--danger)' }}
              onClick={async () => {
                if (!confirm('Delete your Spinroom account? This can’t be undone.')) return;
                await api.call('me.delete');
                location.href = '/';
              }}
            >
              Delete my account
            </button>
          </section>
        </>
      )}
    </div>
  );
}

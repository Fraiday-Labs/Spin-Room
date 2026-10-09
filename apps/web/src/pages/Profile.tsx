import { AVATAR_COLORS } from '@spinroom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'wouter';
import { LineIcon } from '../components/LineIcon';
import { PageSkeleton } from '../components/PageSkeleton';
import { ProfilePhoto } from '../components/ProfilePhoto';
import l from '../components/SettingsList.module.css';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';
import { AvatarSprite } from '../room/AvatarSprite';
import { AvatarStudio } from '../studio/AvatarStudio';
import { IntegrationsPanel } from './Integrations';
import s from './Profile.module.css';

const SECTIONS = [
  ['', 'Profile'],
  ['avatar', 'Avatar studio'],
  ['integrations', 'Integrations'],
] as const;

export default function Profile({ tab, sub }: { tab?: string; sub?: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api.call('tokens.list'), enabled: !!me.data });
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (me.isLoading) return <PageSkeleton cards={3} />;
  if (!me.data)
    return (
      <a className="page btn btn-spotify" href={signInUrl()}>
        Sign in
      </a>
    );
  const u = me.data;
  const agents = tokens.data?.filter((t) => !t.revokedAt) ?? [];
  const nameChanged = name !== null && name.trim() !== u.displayName && name.trim().length > 0;
  return (
    <div className={`page stack ${s.page}`}>
      <div className="row">
        <AvatarSprite avatar={u.avatar} state="wave" width={96} />
        <div className="stack" style={{ gap: 4 }}>
          <h1 style={{ margin: 0 }}>{u.displayName}</h1>
          <div className="row" style={{ gap: 8 }}>
            <span className={u.isPremium ? 'badge badge-ok' : 'badge'}>{u.isPremium ? 'Spotify Premium' : 'Spotify Free'}</span>
            <span className="badge">{u.points} DJ points</span>
          </div>
        </div>
      </div>
      <nav className={s.segmented} aria-label="Profile sections">
        {SECTIONS.map(([id, label]) => (
          <Link key={id} href={id ? `/profile/${id}` : '/profile'} className={s.segment} aria-current={(tab ?? '') === id ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === 'avatar' ? (
        <AvatarStudio me={u} />
      ) : tab === 'integrations' ? (
        <IntegrationsPanel me={u} sub={sub} />
      ) : (
        <>
          <section className={l.group} aria-labelledby="you">
            <h2 id="you" className={l.heading}>
              You
            </h2>
            <div className={l.list}>
              <ProfilePhoto me={u} />
              <form
                className={l.item}
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    qc.setQueryData(['me'], await api.call('me.patch', { body: { displayName: (name ?? u.displayName).trim() } }));
                    setName(null);
                    setMsg('Saved.');
                  } catch (err) {
                    setMsg(errorMessage(err));
                  }
                }}
              >
                <label className={l.itemText} htmlFor="display-name">
                  <span className={l.label}>Display name</span>
                  <span className={l.hint}>What the room sees over your avatar and in chat.</span>
                  {msg && (
                    <span role="status" className={l.hint}>
                      {msg}
                    </span>
                  )}
                </label>
                <div className={l.actions}>
                  <input
                    id="display-name"
                    className={`input ${s.nameInput}`}
                    value={name ?? u.displayName}
                    maxLength={40}
                    onChange={(e) => {
                      setName(e.target.value);
                      setMsg(null);
                    }}
                  />
                  <button className="btn btn-sm btn-primary" type="submit" disabled={!nameChanged}>
                    Save
                  </button>
                </div>
              </form>
              <div className={l.item}>
                <div className={l.itemText}>
                  <span className={l.label}>Crowd color</span>
                  <span className={l.hint}>Your name tag on the dance floor.</span>
                </div>
                <div className={`${l.actions} ${s.swatches}`} role="radiogroup" aria-label="Crowd color">
                  {AVATAR_COLORS.map((c) => {
                    const on = u.avatarColor.toUpperCase() === c.toUpperCase();
                    return (
                      <button
                        key={c}
                        role="radio"
                        aria-checked={on}
                        aria-label={c}
                        className={s.swatch}
                        style={{ background: c }}
                        onClick={async () => qc.setQueryData(['me'], await api.call('me.patch', { body: { avatarColor: c } }))}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section className={l.group} aria-labelledby="connections">
            <h2 id="connections" className={l.heading}>
              Connections
            </h2>
            <div className={l.list}>
              <div className={l.item}>
                <div className={l.itemText}>
                  <span className={l.label}>Spotify</span>
                  <span className={l.hint}>
                    Signed in as {u.email ?? u.displayName}
                    {u.spotifyClientId && ` · your own Spotify app (${u.spotifyClientId.slice(0, 6)}…)`}
                  </span>
                </div>
                <span className="badge badge-ok">Connected</span>
              </div>
              <div className={l.item}>
                <div className={l.itemText}>
                  <span className={l.label}>Slack</span>
                  <span className={l.hint}>{u.connections.slack ? 'Linked — vote, queue and chat from Slack.' : 'Not linked yet.'}</span>
                </div>
                <div className={l.actions}>
                  {u.connections.slack ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        await api.call('me.unlinkIdentity', { params: { provider: 'slack' } });
                        await qc.invalidateQueries({ queryKey: ['me'] });
                      }}
                    >
                      Unlink
                    </button>
                  ) : (
                    <Link href="/profile/integrations/slack" className="btn btn-sm">
                      Set up
                    </Link>
                  )}
                </div>
              </div>
              <div className={l.item}>
                <div className={l.itemText}>
                  <span className={l.label}>Coding agents</span>
                  <span className={l.hint}>{agents.length ? `${agents.length} connected` : 'Use Spinroom from Claude, Cursor and other MCP clients.'}</span>
                </div>
                <div className={l.actions}>
                  <Link href="/profile/integrations" className="btn btn-sm">
                    {agents.length ? 'Add another' : 'Set up'}
                    <LineIcon name="forward" size={14} />
                  </Link>
                </div>
                {agents.length > 0 && (
                  <ul className={l.sub}>
                    {agents.map((t) => (
                      <li key={t.id}>
                        <span>
                          {t.label}{' '}
                          <span className="muted" style={{ fontSize: 13 }}>
                            · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : 'never used'}
                          </span>
                        </span>
                        <button
                          className="btn btn-ghost btn-sm"
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
                )}
              </div>
            </div>
          </section>

          <section className={l.group} aria-labelledby="danger">
            <h2 id="danger" className={l.heading}>
              Danger zone
            </h2>
            <div className={`${l.list} ${l.danger}`}>
              <div className={l.item}>
                <div className={l.itemText}>
                  <span className={l.label}>Delete account</span>
                  <span className={l.hint}>Removes your profile, sets, tokens and connections now; anything left is purged within 30 days.</span>
                </div>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={async () => {
                    if (!confirm('Delete your Spinroom account? This can’t be undone.')) return;
                    await api.call('me.delete');
                    location.href = '/';
                  }}
                >
                  Delete my account
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

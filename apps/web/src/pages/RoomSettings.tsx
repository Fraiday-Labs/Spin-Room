import type { Room, RoomSettings as Settings } from '@spinroom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { CopyButton } from '../components/CopyButton';
import { RoomLifecycle } from '../components/RoomLifecycle';
import { api, errorMessage, useMe } from '../lib/api';

const MIN = 60_000;

export default function RoomSettings({ slug }: { slug?: string }) {
  const qc = useQueryClient();
  const me = useMe();
  const [, navigate] = useLocation();
  const snap = useQuery({ queryKey: ['room', slug], queryFn: () => api.call('rooms.get', { params: { slug: slug! } }) });
  const invites = useQuery({ queryKey: ['invites', slug], queryFn: () => api.call('invites.list', { params: { slug: slug! } }) });
  const members = useQuery({ queryKey: ['members', slug], queryFn: () => api.call('rooms.members', { params: { slug: slug! } }) });
  const [room, setRoom] = useState<Room | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newInvite, setNewInvite] = useState<string | null>(null);
  useEffect(() => {
    if (snap.data) setRoom(snap.data.room);
  }, [snap.data]);
  if (snap.error) return <div className="page notice error">{errorMessage(snap.error)}</div>;
  if (!room || !snap.data) return <div className="page muted">Loading…</div>;
  const s = room.settings;
  const set = (patch: Partial<Settings>) => setRoom({ ...room, settings: { ...s, ...patch } });
  const isOwner = snap.data.me?.role === 'owner' || !!me.data?.isAdmin;
  const num = (label: string, key: keyof Settings, opts: { min: number; max: number; step?: number; scale?: number; help?: string; nullable?: boolean }) => {
    const raw = s[key] as number | null;
    const scale = opts.scale ?? 1;
    return (
      <label className="field">
        {label}
        <input
          className="input"
          type="number"
          min={opts.min}
          max={opts.max}
          step={opts.step ?? 1}
          value={raw === null ? '' : raw / scale}
          placeholder={opts.nullable ? 'Off' : undefined}
          onChange={(e) => set({ [key]: e.target.value === '' && opts.nullable ? null : Number(e.target.value) * scale } as Partial<Settings>)}
        />
        {opts.help && <span className="muted">{opts.help}</span>}
      </label>
    );
  };
  return (
    <div className="page stack" style={{ maxWidth: 760 }}>
      <Link href={`/r/${slug}`}>← Back to the room</Link>
      <h1>Room settings</h1>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          try {
            const updated = await api.call('rooms.patch', {
              params: { slug: slug! },
              body: { name: room.name, description: room.description, visibility: room.visibility, settings: room.settings },
            });
            setRoom(updated);
            await qc.invalidateQueries({ queryKey: ['room', slug] });
            setMsg('Saved.');
          } catch (err) {
            setMsg(errorMessage(err));
          }
        }}
      >
        <label className="field">
          Name
          <input className="input" value={room.name} onChange={(e) => setRoom({ ...room, name: e.target.value })} />
        </label>
        <label className="field">
          Description
          <input className="input" value={room.description} maxLength={280} onChange={(e) => setRoom({ ...room, description: e.target.value })} />
        </label>
        <label className="field">
          Visibility
          <select className="input" value={room.visibility} onChange={(e) => setRoom({ ...room, visibility: e.target.value as Room['visibility'] })}>
            <option value="public">Public</option>
            <option value="invite_only">Invite only</option>
          </select>
        </label>
        <h2>Votes</h2>
        <div className="row">
          {num('Auto-skip at Skip share (%)', 'skipRatio', { min: 10, max: 100, scale: 0.01, help: 'Of listeners with a live speaker' })}
          {num('…and at least this many Skips', 'minSkips', { min: 1, max: 50 })}
          {num('Bounce after auto-skips in a row', 'bounceAfter', { min: 1, max: 10 })}
          {num('Bounce cooldown (minutes)', 'bounceCooldownMs', { min: 0, max: 60, scale: MIN })}
        </div>
        <h2>Booth</h2>
        <div className="row">
          {num('DJ slots', 'boothSlots', { min: 1, max: 3 })}
          {num('Spins per turn', 'turnLimit', { min: 1, max: 50, nullable: true, help: 'Empty = no limit' })}
          {num('Longest track (minutes)', 'maxTrackMs', { min: 1, max: 60, scale: MIN })}
          {num('No repeats within last N spins', 'noRepeatWindow', { min: 1, max: 200, nullable: true, help: 'Empty = off' })}
        </div>
        <label className="row">
          <input type="checkbox" checked={s.blockExplicit} onChange={(e) => set({ blockExplicit: e.target.checked })} /> Block explicit tracks
        </label>
        <h2>Room</h2>
        <div className="row">
          {num('Max people at once', 'maxPresent', { min: 2, max: 500 })}
          {num('Invite links last (days)', 'inviteTtlMs', { min: 1, max: 90, scale: 86_400_000 })}
        </div>
        {msg && <p role="status">{msg}</p>}
        <button className="btn btn-primary" type="submit" style={{ justifySelf: 'start' }}>
          Save settings
        </button>
      </form>

      <section className="card stack">
        <h2>Invites</h2>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              const inv = await api.call('invites.create', { params: { slug: slug! }, body: {} });
              setNewInvite(inv.url);
              await invites.refetch();
            }}
          >
            New invite link
          </button>
          {newInvite && (
            <>
              <code>{newInvite}</code>
              <CopyButton text={newInvite} />
            </>
          )}
        </div>
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {invites.data?.map((i) => (
            <li key={i.id} className="row">
              <span className="muted">
                Used {i.uses}× · {i.expiresAt ? `expires ${new Date(i.expiresAt).toLocaleDateString()}` : 'never expires'}
              </span>
              <button
                className="btn btn-ghost"
                onClick={async () => {
                  await api.call('invites.revoke', { params: { id: i.id } });
                  await invites.refetch();
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card stack">
        <h2>Members and roles</h2>
        <table>
          <tbody>
            {members.data?.map((m) => (
              <tr key={m.userId}>
                <td>{m.displayName}</td>
                <td>
                  <span className="badge">{m.role}</span> {m.banned && <span className="badge badge-warn">banned</span>}{' '}
                  {m.muted && <span className="badge">muted</span>}
                </td>
                <td>
                  {isOwner && m.role !== 'owner' && (
                    <button
                      className="btn btn-ghost"
                      onClick={async () => {
                        await api.call('rooms.moderate', {
                          params: { slug: slug! },
                          body: { action: 'set_role', userId: m.userId, role: m.role === 'moderator' ? 'member' : 'moderator' },
                        });
                        await members.refetch();
                      }}
                    >
                      {m.role === 'moderator' ? 'Remove moderator' : 'Make moderator'}
                    </button>
                  )}
                  {m.banned && (
                    <button
                      className="btn btn-ghost"
                      onClick={async () => {
                        await api.call('rooms.moderate', { params: { slug: slug! }, body: { action: 'unban', userId: m.userId } });
                        await members.refetch();
                      }}
                    >
                      Unban
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {isOwner && (
        <section className="card stack">
          <h2>Close or delete this room</h2>
          <p className="muted">
            Closing stops the music, sends everyone out and hides the room; you can reopen it from your rooms in the lobby. Deleting removes it for good.
          </p>
          <RoomLifecycle room={room} onDone={() => navigate('/lobby')} />
        </section>
      )}

      <section className="card stack">
        <h2>Slack</h2>
        <p>
          To show this room in a Slack channel, install the Spinroom Slack app and run <code>/spinroom link {slug}</code> in the channel. Owners and moderators
          can link channels.
        </p>
      </section>
    </div>
  );
}

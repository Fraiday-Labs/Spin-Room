import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';

export default function InviteLanding({ token }: { token?: string }) {
  const me = useMe();
  const [, navigate] = useLocation();
  const [err, setErr] = useState<string | null>(null);
  const inv = useQuery({ queryKey: ['invite', token], queryFn: () => api.call('invites.preview', { params: { token: token! } }), retry: false });
  if (inv.error) {
    return (
      <div className="page stack">
        <h1>Invite expired</h1>
        <p className="notice error">{errorMessage(inv.error)}</p>
      </div>
    );
  }
  if (!inv.data) return <div className="page muted">Loading invite…</div>;
  const room = inv.data.room;
  return (
    <div className="page stack" style={{ maxWidth: 560 }}>
      <h1>You’re invited to {room.name}</h1>
      {room.description && <p className="muted">{room.description}</p>}
      <p>
        {room.listeners} here now{room.nowPlaying ? ` · playing ${room.nowPlaying.title}` : ''}.
      </p>
      {me.data ? (
        <button
          className="btn btn-primary"
          style={{ justifySelf: 'start' }}
          onClick={async () => {
            try {
              await api.call('invites.accept', { params: { token: token! } });
              navigate(`/r/${room.slug}`);
            } catch (e) {
              setErr(errorMessage(e));
            }
          }}
          data-testid="accept-invite"
        >
          Join the room
        </button>
      ) : (
        <a className="btn btn-spotify" style={{ justifySelf: 'start' }} href={signInUrl(location.pathname)}>
          Sign in with Spotify to join
        </a>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

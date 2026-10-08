import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';

export default function InviteLanding({ token }: { token?: string }) {
  const me = useMe();
  const [, navigate] = useLocation();
  const inv = useQuery({ queryKey: ['invite', token], queryFn: () => api.call('invites.preview', { params: { token: token! } }), retry: false });
  // Where the invite leads: the room, which accepts the invite as it joins (and highlights Start speaker).
  const target = inv.data ? `/r/${inv.data.room.slug}?invite=${encodeURIComponent(token!)}&speaker=1` : null;
  // Already signed in: no extra click, straight into the room.
  useEffect(() => {
    if (me.data && target) navigate(target, { replace: true });
  }, [me.data, target, navigate]);
  if (inv.error) {
    return (
      <div className="page stack">
        <h1>Invite expired</h1>
        <p className="notice error">{errorMessage(inv.error)}</p>
      </div>
    );
  }
  if (!inv.data || me.isLoading || me.data) return <div className="page muted">{me.data ? 'Joining…' : 'Loading invite…'}</div>;
  const room = inv.data.room;
  return (
    <div className="page stack" style={{ maxWidth: 560 }}>
      <h1>You’re invited to {room.name}</h1>
      {room.description && <p className="muted">{room.description}</p>}
      <p>
        {room.listeners} here now{room.nowPlaying ? ` · playing ${room.nowPlaying.title}` : ''}.
      </p>
      <a className="btn btn-spotify" style={{ justifySelf: 'start' }} href={signInUrl(target!)} data-testid="invite-sign-in">
        Sign in with Spotify to join
      </a>
      <p className="muted">Spinroom plays music through your Spotify Premium account. After you sign in you’ll go straight into the room.</p>
    </div>
  );
}

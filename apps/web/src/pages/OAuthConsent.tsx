import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';

/** Consent screen for remote MCP clients (OAuth 2.1 authorize step). */
export default function OAuthConsent() {
  const me = useMe();
  const id = new URLSearchParams(location.search).get('request') ?? '';
  const req = useQuery({ queryKey: ['oauth', id], queryFn: () => api.call('oauth.request', { params: { id } }), enabled: !!me.data && !!id, retry: false });
  const [busy, setBusy] = useState(false);
  if (me.isLoading) return <div className="page muted">Loading…</div>;
  if (!me.data) {
    return (
      <div className="page stack" style={{ maxWidth: 520 }}>
        <h1>Connect your agent</h1>
        <p>Sign in to Spinroom to continue.</p>
        <a className="btn btn-spotify" style={{ justifySelf: 'start' }} href={signInUrl()}>
          Sign in with Spotify
        </a>
      </div>
    );
  }
  if (req.error) return <div className="page notice error">{errorMessage(req.error)}</div>;
  if (!req.data) return <div className="page muted">Loading…</div>;
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const r = await api.call('oauth.approve', { params: { id }, body: { approve } });
      location.href = r.redirectTo;
    } catch (e) {
      alert(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div className="page stack" style={{ maxWidth: 520 }}>
      <h1>Allow {req.data.clientName}?</h1>
      <div className="card stack">
        <p>
          <b>{req.data.clientName}</b> wants to use Spinroom as <b>{me.data.displayName}</b>:
        </p>
        <ul>
          <li>see rooms and what’s playing</li>
          <li>join rooms, vote, chat and manage your DJ set and queue</li>
          <li>create rooms and invite links</li>
        </ul>
        <p className="muted">
          It will never see your Spotify login. After approving you’ll return to {req.data.redirectHost}. Revoke access any time on your Profile.
        </p>
        <div className="row">
          <button className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}>
            Allow
          </button>
          <button className="btn" disabled={busy} onClick={() => void decide(false)}>
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

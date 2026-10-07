import { useEffect, useState } from 'react';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';

/** Landing page for the Slack "Connect Spinroom" button. */
export default function SlackLink() {
  const me = useMe();
  const p = new URLSearchParams(location.search);
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!me.data || state !== 'idle') return;
    api
      .call('me.linkIdentity', {
        body: { provider: 'slack', teamId: p.get('team') ?? '', externalId: p.get('user') ?? '', exp: Number(p.get('exp')), sig: p.get('sig') ?? '' },
      })
      .then(() => setState('done'))
      .catch((e) => {
        setErr(errorMessage(e));
        setState('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data]);
  if (me.isLoading) return <div className="page muted">Loading…</div>;
  if (!me.data) {
    return (
      <div className="page stack" style={{ maxWidth: 560 }}>
        <h1>Connect Slack to Spinroom</h1>
        <p>Sign in with Spotify to link your Slack account.</p>
        <a className="btn btn-spotify" style={{ justifySelf: 'start' }} href={signInUrl()}>
          Sign in with Spotify
        </a>
      </div>
    );
  }
  return (
    <div className="page stack" style={{ maxWidth: 560 }}>
      <h1>Connect Slack</h1>
      {state === 'idle' && <p className="muted">Linking…</p>}
      {state === 'done' && (
        <p className="notice">Done — your Slack account is linked. You can vote, DJ and add songs from Slack now. You can close this tab.</p>
      )}
      {state === 'error' && <p className="notice error">{err}</p>}
    </div>
  );
}

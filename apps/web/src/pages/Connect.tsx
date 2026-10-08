import { SPOTIFY_CLIENT_ID_RE } from '@spinroom/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CopyButton } from '../components/CopyButton';
import s from './Connect.module.css';

/** Why login failed and how to fix it (PRD option B, step 6). */
const FAILURES: Record<string, { title: string; fix: string }> = {
  invalid_client_id: {
    title: 'That Client ID doesn’t look right',
    fix: 'Copy the 32-character Client ID from your app’s Basic Information page in the Spotify developer dashboard.',
  },
  redirect_uri_mismatch: {
    title: 'Redirect URI mismatch',
    fix: 'In your Spotify app’s settings, add the callback URL below exactly as shown (including http/https and port), then save.',
  },
  user_not_allowlisted: {
    title: 'Your Spotify account isn’t on this app’s allowlist',
    fix: 'Development-mode apps only allow listed users. In the dashboard open User Management and add your Spotify email — or ask the friend whose app you used to add you.',
  },
  premium_required: {
    title: 'Spinroom needs Spotify Premium',
    fix: 'Spinroom is for listening together, and Spotify only lets Premium accounts play music in other apps. Upgrade at spotify.com/premium (or sign in with a Premium account), then try again.',
  },
  access_denied: { title: 'Spotify sign-in was cancelled', fix: 'Try again and press Agree on the Spotify screen.' },
  state_expired: { title: 'The sign-in link expired', fix: 'Start again — sign-in links last 10 minutes.' },
  quota_exceeded: {
    title: 'This Spotify app is over its quota',
    fix: 'Spotify limits requests per developer account. Wait a little, or use your own Client ID.',
  },
  spotify_error: {
    title: 'Spotify returned an error',
    fix: 'Try again in a moment. If it keeps happening, check that Web API and Web Playback SDK are selected for your app.',
  },
};

export function Connect() {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  const detail = params.get('detail');
  const returnTo = params.get('return_to') ?? '/lobby';
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.call('auth.config') });
  const [clientId, setClientId] = useState('');
  const [friendMode, setFriendMode] = useState(false);

  useEffect(() => {
    if (cfg.data?.rememberedClientId) setClientId(cfg.data.rememberedClientId);
    try {
      if (!sessionStorage.getItem('sr_setup_started')) sessionStorage.setItem('sr_setup_started', String(Date.now()));
    } catch {
      /* storage unavailable */
    }
  }, [cfg.data?.rememberedClientId]);

  const valid = SPOTIFY_CLIENT_ID_RE.test(clientId.trim());
  const start = (id?: string) => {
    const q = new URLSearchParams({ return_to: returnTo, ...(id ? { client_id: id.trim() } : {}) });
    location.href = `/v1/auth/spotify/start?${q}`;
  };
  const hosted = !!cfg.data?.hostedSpotifyApp;
  const failure = error
    ? hosted && error === 'user_not_allowlisted' && !cfg.data?.rememberedClientId
      ? {
          title: 'You’re not on this Spinroom’s Spotify guest list yet',
          fix: 'Spotify only lets people the host has added sign in. Send the host the email address on your Spotify account (spotify.com/account), then try again once they’ve added you.',
        }
      : (FAILURES[error] ?? FAILURES.spotify_error!)
    : null;

  return (
    <div className="page stack" style={{ maxWidth: 760 }}>
      <h1>{hosted ? 'Sign in' : 'Connect Spotify'}</h1>
      {!hosted && (
        <p className="muted">
          Spinroom plays music through your own Spotify Premium account. Spotify limits each developer app to a handful of users, so every listener brings their
          own free Spotify developer app. It takes about five minutes, once.
        </p>
      )}

      {failure && (
        <div className="notice error" role="alert">
          <strong>{failure.title}.</strong> {failure.fix}
          {detail && <div className="muted mono">Spotify said: {detail}</div>}
        </div>
      )}

      {cfg.data?.spotifyMode === 'fake' && (
        <div className="card stack">
          <h2>Development mode</h2>
          <p className="muted">This server uses a fake Spotify (SPOTIFY_MODE=fake). Sign in as a test user — no Spotify account needed.</p>
          <div>
            <button className="btn btn-primary" onClick={() => start()}>
              Continue to test sign-in
            </button>
          </div>
        </div>
      )}

      {cfg.data?.spotifyMode !== 'fake' && (
        <>
          {hosted && (
            <div className="card stack">
              <p style={{ margin: 0 }}>
                Spinroom plays music through your own Spotify account, so you’ll need <b>Spotify Premium</b>.
              </p>
              <div>
                <button className="btn btn-spotify" onClick={() => start()} data-testid="spotify-sign-in">
                  Sign in with Spotify
                </button>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                First time here? The host adds you to Spinroom’s Spotify guest list using the email on your Spotify account. If Spotify says you’re not on the
                list, send them that email.
              </p>
            </div>
          )}
          <details className="card" open={!hosted || !!cfg.data?.rememberedClientId || error === 'invalid_client_id' || error === 'redirect_uri_mismatch'}>
            <summary>
              <b>{hosted ? 'Use your own Spotify app instead' : 'Set up your Spotify app'}</b>
              {hosted && <span className="muted"> · only if the host’s guest list is full</span>}
            </summary>
            <div style={{ marginTop: 12 }}>
              <ol className={s.steps}>
                <li>
                  <h3>Create a Spotify app</h3>
                  <p>
                    Open the{' '}
                    <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
                      Spotify developer dashboard
                    </a>
                    , sign in, and choose <b>Create app</b>. Any name works (for example “My Spinroom”).
                  </p>
                  <figure className={s.shot} aria-hidden="true">
                    <div className={s.mockBar}>Create app</div>
                    <div className={s.mockField}>App name: My Spinroom</div>
                    <div className={s.mockField}>
                      Which API/SDKs? <b>☑ Web API</b> <b>☑ Web Playback SDK</b>
                    </div>
                  </figure>
                </li>
                <li>
                  <h3>Select Web API and Web Playback SDK</h3>
                  <p>Both boxes are needed: Web API for search and playlists, Web Playback SDK for the speaker tab.</p>
                </li>
                <li>
                  <h3>Add this Redirect URI</h3>
                  <div className={s.copyRow}>
                    <code className={s.code}>{cfg.data?.callbackUrl ?? '…'}</code>
                    {cfg.data && <CopyButton text={cfg.data.callbackUrl} />}
                  </div>
                  <p className="muted">Paste it into Redirect URIs, press Add, then Save at the bottom of the form.</p>
                </li>
                <li>
                  <h3>Paste your Client ID</h3>
                  <p className="muted">It’s on the app’s Basic Information page. A Client ID isn’t a secret, and Spinroom never needs a client secret.</p>
                  <form
                    className="stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (valid) start(clientId);
                    }}
                  >
                    <label className="field">
                      {friendMode ? 'Your friend’s Client ID' : 'Client ID'}
                      <input
                        className="input mono"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder="32 characters, e.g. 0f1e2d3c4b5a69788796a5b4c3d2e1f0"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={clientId.length > 0 && !valid}
                      />
                    </label>
                    {clientId.length > 0 && !valid && <span className="error">Client IDs are 32 letters and digits (0–9, a–f).</span>}
                    <div className="row">
                      <button className="btn btn-spotify" type="submit" disabled={!valid}>
                        Connect Spotify
                      </button>
                    </div>
                  </form>
                </li>
              </ol>
            </div>
          </details>

          <details className="card" open={friendMode} onToggle={(e) => setFriendMode((e.target as HTMLDetailsElement).open)}>
            <summary>
              <b>Join through a friend’s app instead</b>
            </summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <p>
                A friend can let up to 4 people sign in through their Spotify app. Ask them to open <b>User Management</b> in their app’s dashboard and add your
                name and the email on your Spotify account. Then paste <i>their</i> Client ID above.
              </p>
              <p className="muted">Guests share the host’s Spotify API quota.</p>
            </div>
          </details>

          <p className="muted">Spinroom asks Spotify for: {cfg.data?.scopes.join(', ')}. A Spotify Premium account is required.</p>
        </>
      )}
    </div>
  );
}

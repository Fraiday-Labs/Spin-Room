import { afterEach, describe, expect, it } from 'vitest';
import { createAesSealer, pkceChallenge } from '../src/lib/crypto.js';
import { RealSpotifyGateway } from '../src/spotify/real.js';
import { cookiesFrom, createTestApp, login, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => t?.close());

describe('Spotify login (fake mode)', () => {
  it('signs in a Premium user and shows the profile', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice', { displayName: 'Alice' });
    const me = (await u.req('GET', '/v1/me')).json();
    expect(me).toMatchObject({ displayName: 'Alice', isPremium: true, remoteOnly: false, spotifyUserId: 'alice' });
    expect(me.avatar.kind).toBe('preset');
  });

  it('flags a Free account as remote-only', async () => {
    t = await createTestApp();
    const u = await login(t, 'bob', { premium: false });
    const me = (await u.req('GET', '/v1/me')).json();
    expect(me).toMatchObject({ isPremium: false, remoteOnly: true });
    const tok = await u.req('GET', '/v1/me/spotify-token');
    expect(tok.statusCode).toBe(403);
  });

  it('runs the full PKCE redirect flow with cookies', async () => {
    t = await createTestApp();
    const start = await t.app.inject({ method: 'GET', url: '/v1/auth/spotify/start?return_to=/rooms/lounge' });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string, 'http://x');
    expect(loc.pathname).toBe('/dev-login');
    const state = loc.searchParams.get('state')!;
    const cb = await t.app.inject({ method: 'GET', url: `/v1/auth/spotify/callback?code=carol.premium&state=${state}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/rooms/lounge');
    const cookies = cookiesFrom(cb);
    expect(cookies.sr_at).toBeTruthy();
    expect(cookies.sr_rt).toBeTruthy();
    const me = await t.app.inject({ method: 'GET', url: '/v1/me', cookies: { sr_at: cookies.sr_at! } });
    expect(me.json().spotifyUserId).toBe('carol');

    // State is single use.
    const again = await t.app.inject({ method: 'GET', url: `/v1/auth/spotify/callback?code=carol.premium&state=${state}` });
    expect(again.headers.location).toContain('error=state_expired');

    // Cookie writes need CSRF.
    const noCsrf = await t.app.inject({ method: 'PATCH', url: '/v1/me', cookies: { sr_at: cookies.sr_at! }, payload: { displayName: 'C' } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('csrf_failed');
    const withCsrf = await t.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      cookies: { sr_at: cookies.sr_at!, sr_csrf: cookies.sr_csrf! },
      headers: { 'x-csrf-token': cookies.sr_csrf! },
      payload: { displayName: 'Carol C' },
    });
    expect(withCsrf.statusCode).toBe(200);
    expect(withCsrf.json().displayName).toBe('Carol C');

    // Refresh rotates the refresh token.
    const r1 = await t.app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: cookies.sr_rt } });
    expect(r1.statusCode).toBe(200);
    const r2 = await t.app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: cookies.sr_rt } });
    expect(r2.json().code).toBe('session_expired');
    expect(r1.json().refreshToken).not.toBe(cookies.sr_rt);
  });

  it('only hands Spotify tokens to the speaker page origin', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/fake/login', payload: { spotifyUserId: 'dee' } });
    const c = cookiesFrom(res);
    const bad = await t.app.inject({ method: 'GET', url: '/v1/me/spotify-token', cookies: { sr_at: c.sr_at! }, headers: { origin: 'https://evil.example' } });
    expect(bad.json().code).toBe('origin_rejected');
    const good = await t.app.inject({ method: 'GET', url: '/v1/me/spotify-token', cookies: { sr_at: c.sr_at! }, headers: { origin: t.ctx.cfg.PUBLIC_ORIGIN } });
    expect(good.statusCode).toBe(200);
    expect(good.json().accessToken).toBe('fake.dee.premium');
  });

  it('returns problem JSON for unknown routes and bad input', async () => {
    t = await createTestApp();
    const nf = await t.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.headers['content-type']).toContain('application/problem+json');
    const u = await login(t, 'eve');
    const bad = await u.req('PATCH', '/v1/me', { avatarColor: 'red' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('validation_failed');
  });
});

describe('Spotify login (real mode, option B)', () => {
  function fakeFetch(handlers: Record<string, (init: RequestInit) => Response>) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      for (const [k, h] of Object.entries(handlers)) if (url.includes(k)) return h(init ?? {});
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  }

  it('rejects a malformed Client ID', async () => {
    t = await createTestApp({ cfg: { SPOTIFY_MODE: 'real' } });
    const res = await t.app.inject({ method: 'GET', url: '/v1/auth/spotify/start?client_id=nope' });
    expect(res.headers.location).toBe('/connect?error=invalid_client_id');
  });

  it('starts PKCE with the user’s own Client ID and names failures', async () => {
    const clientId = 'a'.repeat(32);
    let mode: 'mismatch' | 'not_allowlisted' | 'ok_free' = 'mismatch';
    const spotify = new RealSpotifyGateway({
      accountsUrl: 'https://accounts.test',
      apiUrl: 'https://api.test/v1',
      retries: 0,
      fetch: fakeFetch({
        '/api/token': (init) => {
          const body = new URLSearchParams(String(init.body));
          expect(body.get('client_id')).toBe(clientId);
          expect(body.get('code_verifier')).toBeTruthy();
          if (mode === 'mismatch') return Response.json({ error: 'invalid_grant', error_description: 'Invalid redirect URI' }, { status: 400 });
          return Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'streaming' });
        },
        '/v1/me': () =>
          mode === 'not_allowlisted'
            ? Response.json({ error: { status: 403, message: 'User not registered in the Developer Dashboard' } }, { status: 403 })
            : Response.json({ id: 'frank', display_name: 'Frank', product: 'free', email: 'f@x.test' }),
      }),
    });
    t = await createTestApp({ cfg: { SPOTIFY_MODE: 'real' }, spotify });

    const run = async () => {
      const start = await t.app.inject({ method: 'GET', url: `/v1/auth/spotify/start?client_id=${clientId}` });
      const loc = new URL(start.headers.location as string);
      expect(loc.origin).toBe('https://accounts.test');
      expect(loc.searchParams.get('client_id')).toBe(clientId);
      expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
      expect(loc.searchParams.get('scope')).toContain('streaming');
      expect(cookiesFrom(start).sr_cid).toBe(clientId);
      const state = loc.searchParams.get('state');
      return t.app.inject({ method: 'GET', url: `/v1/auth/spotify/callback?code=c&state=${state}` });
    };

    expect((await run()).headers.location).toContain('error=redirect_uri_mismatch');
    mode = 'not_allowlisted';
    expect((await run()).headers.location).toContain('error=user_not_allowlisted');
    mode = 'ok_free';
    const ok = await run();
    expect(ok.headers.location).toBe('/lobby?remote_only=1');
    const me = await t.app.inject({ method: 'GET', url: '/v1/me', cookies: { sr_at: cookiesFrom(ok).sr_at! } });
    expect(me.json()).toMatchObject({ spotifyClientId: clientId, remoteOnly: true });
    const cfg = await t.app.inject({ method: 'GET', url: '/v1/auth/config', cookies: { sr_cid: clientId } });
    expect(cfg.json()).toMatchObject({ spotifyMode: 'real', rememberedClientId: clientId });
  });
});

describe('crypto', () => {
  it('seals and opens', () => {
    const s = createAesSealer(Buffer.alloc(32, 7).toString('base64'));
    const sealed = s.seal('secret-token');
    expect(sealed).not.toContain('secret');
    expect(s.open(sealed)).toBe('secret-token');
  });
  it('computes S256 challenges', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

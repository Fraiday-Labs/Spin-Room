import { SPOTIFY_CLIENT_ID_RE, SPOTIFY_SCOPES, SpinroomError } from '@spinroom/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { callbackUrl } from '../config.js';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { COOKIES, clearSessionCookies, setSessionCookies } from '../http/auth.js';
import { REPLIED, type Handlers } from '../http/router.js';
import { pkcePair } from '../lib/crypto.js';
import { randomToken } from '../lib/ids.js';
import { fakeAccessToken } from '../spotify/fake.js';
import { SpotifyApiError, type SpotifyTokenSet } from '../spotify/gateway.js';

interface PkceState {
  verifier: string;
  clientId: string;
  returnTo: string;
  mode: 'cookie' | 'token';
}

/** Failures the setup screen explains with a fix (PRD option B step 6). */
export type LoginFailure =
  'invalid_client_id' | 'redirect_uri_mismatch' | 'user_not_allowlisted' | 'access_denied' | 'state_expired' | 'spotify_error' | 'quota_exceeded';

function safeReturnTo(raw: string | undefined, mode: 'cookie' | 'token'): string {
  if (!raw) return mode === 'token' ? 'spinroom://auth' : '/lobby';
  if (mode === 'token') return raw.startsWith('spinroom://') ? raw : 'spinroom://auth';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/lobby';
}

function failRedirect(ctx: AppContext, reply: FastifyReply, failure: LoginFailure, detail?: string): typeof REPLIED {
  ctx.services.analytics.track('spotify_setup_failed', { props: { failure, detail } });
  const q = new URLSearchParams({ error: failure, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
  reply.redirect(`/connect?${q}`, 302);
  return REPLIED;
}

export function classifyTokenError(e: unknown): LoginFailure {
  if (!(e instanceof SpotifyApiError)) return 'spotify_error';
  if (e.isQuota) return 'quota_exceeded';
  const m = `${e.reason} ${e.message}`.toLowerCase();
  if (m.includes('redirect')) return 'redirect_uri_mismatch';
  if (m.includes('invalid_client') || m.includes('client')) return 'invalid_client_id';
  return 'spotify_error';
}

/** After Spotify login: upsert the user, store tokens, and start a session. */
export async function completeLogin(ctx: AppContext, reply: FastifyReply, p: { tokens: SpotifyTokenSet; clientId: string; userAgent?: string }) {
  const profile = await ctx.spotify.getMe(p.tokens.accessToken);
  const { user, created } = await ctx.services.users.upsertFromSpotify(profile, ctx.spotify.mode === 'fake' ? null : p.clientId);
  await ctx.services.spotifyTokens.save(user.id, p.clientId, p.tokens);
  const s = await ctx.services.sessions.create(user.id, p.userAgent);
  setSessionCookies(ctx, reply, s);
  ctx.services.analytics.track('login', { userId: user.id, props: { premium: user.isPremium, created } });
  return { user, session: s };
}

export const authHandlers: Handlers = {
  'auth.config': async ({ ctx, req }) => ({
    spotifyMode: ctx.spotify.mode,
    callbackUrl: callbackUrl(ctx.cfg),
    rememberedClientId: req.cookies[COOKIES.clientId] ?? null,
    scopes: [...SPOTIFY_SCOPES],
    mcpUrl: ctx.cfg.MCP_RESOURCE_URL,
    hostedSpotifyApp: ctx.spotify.mode === 'real' && SPOTIFY_CLIENT_ID_RE.test(ctx.cfg.SPOTIFY_DEV_CLIENT_ID ?? ''),
    slackInstallUrl: ctx.cfg.SLACK_CLIENT_ID ? `${ctx.cfg.PUBLIC_ORIGIN}/v1/integrations/slack/install` : null,
  }),

  'auth.spotifyStart': async ({ ctx, query, req, reply }) => {
    const mode = query.mode ?? 'cookie';
    const clientId = (query.client_id ?? req.cookies[COOKIES.clientId] ?? ctx.cfg.SPOTIFY_DEV_CLIENT_ID ?? (ctx.spotify.mode === 'fake' ? 'fake' : '')).trim();
    if (ctx.spotify.mode === 'real' && !SPOTIFY_CLIENT_ID_RE.test(clientId)) return failRedirect(ctx, reply, 'invalid_client_id');
    const { verifier, challenge } = pkcePair();
    const state = randomToken('st', 18);
    const st: PkceState = { verifier, clientId, returnTo: safeReturnTo(query.return_to, mode), mode };
    await ctx.redis.set(`pkce:${state}`, JSON.stringify(st), 'EX', 600);
    if (ctx.spotify.mode === 'real') {
      reply.setCookie(COOKIES.clientId, clientId, { path: '/', httpOnly: true, secure: ctx.cfg.COOKIE_SECURE, sameSite: 'lax', maxAge: 400 * 86400 });
    }
    reply.redirect(ctx.spotify.authorizeUrl({ clientId, redirectUri: callbackUrl(ctx.cfg), state, challenge, scopes: SPOTIFY_SCOPES }), 302);
    return REPLIED;
  },

  'auth.spotifyCallback': async ({ ctx, query, req, reply }) => {
    if (query.error) return failRedirect(ctx, reply, query.error === 'access_denied' ? 'access_denied' : 'spotify_error', query.error);
    if (!query.state || !query.code) return failRedirect(ctx, reply, 'state_expired');
    const raw = await ctx.redis.getdel(`pkce:${query.state}`);
    if (!raw) return failRedirect(ctx, reply, 'state_expired');
    const st = JSON.parse(raw) as PkceState;

    let tokens: SpotifyTokenSet;
    try {
      tokens = await ctx.spotify.exchangeCode({ clientId: st.clientId, code: query.code, redirectUri: callbackUrl(ctx.cfg), verifier: st.verifier });
    } catch (e) {
      return failRedirect(ctx, reply, classifyTokenError(e), (e as Error).message);
    }
    try {
      const { user, session } = await completeLogin(ctx, reply, { tokens, clientId: st.clientId, userAgent: req.headers['user-agent'] });
      if (st.mode === 'token') {
        const frag = new URLSearchParams({ access_token: session.access, refresh_token: session.refresh, expires_at: String(session.accessExpiresAt) });
        reply.redirect(`${st.returnTo}#${frag}`, 302);
      } else {
        const sep = st.returnTo.includes('?') ? '&' : '?';
        reply.redirect(user.isPremium ? st.returnTo : `${st.returnTo}${sep}remote_only=1`, 302);
      }
      return REPLIED;
    } catch (e) {
      // Development-mode apps answer 403 for users missing from the app's allowlist.
      if (e instanceof SpotifyApiError && e.status === 403) return failRedirect(ctx, reply, 'user_not_allowlisted', e.message);
      if (e instanceof SpotifyApiError) return failRedirect(ctx, reply, e.isQuota ? 'quota_exceeded' : 'spotify_error', e.message);
      throw e;
    }
  },

  'auth.fakeLogin': async ({ ctx, body, req, reply }) => {
    if (ctx.spotify.mode !== 'fake') throw new SpinroomError('not_found', 'Fake login is only available with SPOTIFY_MODE=fake');
    const access = fakeAccessToken(body.spotifyUserId, body.premium);
    const tokens: SpotifyTokenSet = { accessToken: access, refreshToken: `refresh.${access}`, expiresAt: ctx.clock.now() + 3600_000, scope: 'streaming' };
    const { user, session } = await completeLogin(ctx, reply, { tokens, clientId: 'fake', userAgent: req.headers['user-agent'] });
    if (body.displayName && body.displayName !== user.displayName) {
      await ctx.db.update(users).set({ displayName: body.displayName }).where(eq(users.id, user.id));
      user.displayName = body.displayName;
    }
    return { accessToken: session.access, expiresAt: session.accessExpiresAt, refreshToken: session.refresh, me: await ctx.services.users.toMe(user) };
  },

  'auth.refresh': async ({ ctx, body, req, reply }) => {
    const token = body.refreshToken ?? req.cookies[COOKIES.refresh];
    if (!token) throw new SpinroomError('session_expired', 'No refresh token');
    const s = await ctx.services.sessions.refresh(token);
    if (!body.refreshToken) {
      setSessionCookies(ctx, reply, s);
      return { accessToken: s.access, expiresAt: s.accessExpiresAt };
    }
    return { accessToken: s.access, expiresAt: s.accessExpiresAt, refreshToken: s.refresh };
  },

  'auth.logout': async ({ ctx, auth, reply }) => {
    if (auth?.sessionId) await ctx.services.sessions.revoke(auth.sessionId);
    clearSessionCookies(reply);
    return { ok: true as const };
  },

  'time.get': async ({ ctx }) => ({ serverNow: ctx.clock.now() }),
};

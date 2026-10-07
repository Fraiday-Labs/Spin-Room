import { SpinroomError } from '@spinroom/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { apiTokens, identityLinks, oauthClients } from '../db/schema.js';
import { requireUser, type Handlers } from '../http/router.js';
import { pkceChallenge, safeEqual, sha256 } from '../lib/crypto.js';
import { newId, randomToken } from '../lib/ids.js';
import { API_AUDIENCE } from '../lib/jwt.js';

/**
 * OAuth 2.1 authorization server for the remote MCP server (MCP authorization spec):
 * RFC 8414 metadata, RFC 7591 dynamic client registration, authorization code + PKCE,
 * refresh token rotation, and audience-bound access tokens (RFC 8707 `resource`).
 */
const ACCESS_TTL_SEC = 3600;
const CODE_TTL_SEC = 120;
const REQUEST_TTL_SEC = 600;
const EXCHANGE_TTL_SEC = 600;

interface AuthzRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  resource: string;
  scope: string;
}
interface AuthzCode extends AuthzRequest {
  userId: string;
}

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    // Native app custom schemes (e.g. cursor://, vscode://)
    return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.code(status).header('cache-control', 'no-store').send({ error, error_description: description });
}

export function registerOAuth(app: FastifyInstance, ctx: AppContext) {
  app.get('/.well-known/oauth-authorization-server', async () => {
    const issuer = ctx.cfg.PUBLIC_ORIGIN;
    return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['rooms'],
    };
  });

  // RFC 7591 dynamic client registration (public clients only).
  app.post<{ Body: { client_name?: string; redirect_uris?: string[] } }>('/oauth/register', async (req, reply) => {
    const body = req.body ?? {};
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) {
      return oauthError(reply, 400, 'invalid_redirect_uri', 'redirect_uris must be https, loopback http, or an app scheme');
    }
    const clientId = randomToken('mcpc', 16);
    const name = (body.client_name ?? 'MCP client').toString().slice(0, 80);
    await ctx.db.insert(oauthClients).values({ clientId, name, redirectUris: uris, createdAt: ctx.clock.now() });
    return reply.code(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(ctx.clock.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/oauth/authorize', async (req, reply) => {
    const q = req.query;
    const client = q.client_id ? await ctx.db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, q.client_id) }) : null;
    if (!client) return oauthError(reply, 400, 'invalid_client', 'Unknown client_id — register the client first');
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return oauthError(reply, 400, 'invalid_request', 'redirect_uri is not registered for this client');
    const back = (params: Record<string, string>) => {
      const u = new URL(q.redirect_uri!);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (q.state) u.searchParams.set('state', q.state);
      return reply.redirect(u.toString(), 302);
    };
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    const resource = q.resource ?? ctx.cfg.MCP_RESOURCE_URL;
    if (resource.replace(/\/$/, '') !== ctx.cfg.MCP_RESOURCE_URL.replace(/\/$/, '')) return back({ error: 'invalid_target', error_description: 'Unknown resource' });
    const id = randomToken('az', 16);
    const request: AuthzRequest = { clientId: client.clientId, clientName: client.name, redirectUri: q.redirect_uri, state: q.state ?? null, challenge: q.code_challenge, resource: ctx.cfg.MCP_RESOURCE_URL, scope: q.scope ?? 'rooms' };
    await ctx.redis.set(`oauth:req:${id}`, JSON.stringify(request), 'EX', REQUEST_TTL_SEC);
    // The web app handles sign-in (Spotify) and shows the consent screen.
    return reply.redirect(`/oauth/consent?request=${encodeURIComponent(id)}`, 302);
  });

  app.post<{ Body: Record<string, string | undefined> }>('/oauth/token', async (req, reply) => {
    const b = req.body ?? {};
    if (b.grant_type === 'authorization_code') {
      const raw = b.code ? await ctx.redis.getdel(`oauth:code:${sha256(b.code)}`) : null;
      if (!raw) return oauthError(reply, 400, 'invalid_grant', 'Code expired or already used');
      const code = JSON.parse(raw) as AuthzCode;
      if (b.client_id !== code.clientId || b.redirect_uri !== code.redirectUri) return oauthError(reply, 400, 'invalid_grant', 'client_id or redirect_uri mismatch');
      if (!b.code_verifier || !safeEqual(pkceChallenge(b.code_verifier), code.challenge)) return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
      const refresh = randomToken('srm', 32);
      const grantId = newId();
      await ctx.db.insert(apiTokens).values({ id: grantId, userId: code.userId, tokenHash: sha256(refresh), kind: 'mcp_oauth', label: code.clientName, clientId: code.clientId, createdAt: ctx.clock.now() });
      await ctx.db
        .insert(identityLinks)
        .values({ userId: code.userId, provider: 'mcp', teamId: '', externalId: grantId, createdAt: ctx.clock.now() })
        .onConflictDoNothing();
      const access = await ctx.jwt.sign({ sub: code.userId, typ: 'mcp', gid: grantId }, code.resource, ACCESS_TTL_SEC);
      return reply.header('cache-control', 'no-store').send({ access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: code.scope });
    }
    if (b.grant_type === 'refresh_token') {
      const row = b.refresh_token
        ? await ctx.db.query.apiTokens.findFirst({ where: and(eq(apiTokens.tokenHash, sha256(b.refresh_token)), eq(apiTokens.kind, 'mcp_oauth'), isNull(apiTokens.revokedAt)) })
        : null;
      if (!row || (b.client_id && b.client_id !== row.clientId)) return oauthError(reply, 400, 'invalid_grant', 'Refresh token is invalid or revoked');
      const refresh = randomToken('srm', 32);
      await ctx.db.update(apiTokens).set({ tokenHash: sha256(refresh), lastUsedAt: ctx.clock.now() }).where(eq(apiTokens.id, row.id));
      const access = await ctx.jwt.sign({ sub: row.userId, typ: 'mcp', gid: row.id }, ctx.cfg.MCP_RESOURCE_URL, ACCESS_TTL_SEC);
      return reply.header('cache-control', 'no-store').send({ access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: 'rooms' });
    }
    return oauthError(reply, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  app.post<{ Body: Record<string, string | undefined> }>('/oauth/revoke', async (req, reply) => {
    const t = req.body?.token;
    if (t) await ctx.db.update(apiTokens).set({ revokedAt: ctx.clock.now() }).where(and(eq(apiTokens.tokenHash, sha256(t)), eq(apiTokens.kind, 'mcp_oauth')));
    return reply.code(200).send({});
  });
}

async function loadRequest(ctx: AppContext, id: string): Promise<AuthzRequest> {
  const raw = await ctx.redis.get(`oauth:req:${id}`);
  if (!raw) throw new SpinroomError('not_found', 'This sign-in request expired — start again from your agent');
  return JSON.parse(raw) as AuthzRequest;
}

export const oauthHandlers: Handlers = {
  'oauth.request': async (c) => {
    requireUser(c);
    const r = await loadRequest(c.ctx, c.params.id);
    let host = r.redirectUri;
    try {
      const u = new URL(r.redirectUri);
      host = u.host || u.protocol;
    } catch {
      /* keep raw */
    }
    return { clientName: r.clientName, redirectHost: host, scopes: r.scope.split(' ').filter(Boolean) };
  },
  'oauth.approve': async (c) => {
    const { userId } = requireUser(c);
    const r = await loadRequest(c.ctx, c.params.id);
    await c.ctx.redis.del(`oauth:req:${c.params.id}`);
    const u = new URL(r.redirectUri);
    if (r.state) u.searchParams.set('state', r.state);
    if (!c.body.approve) {
      u.searchParams.set('error', 'access_denied');
      return { redirectTo: u.toString() };
    }
    const code = randomToken('mc', 24);
    await c.ctx.redis.set(`oauth:code:${sha256(code)}`, JSON.stringify({ ...r, userId } satisfies AuthzCode), 'EX', CODE_TTL_SEC);
    u.searchParams.set('code', code);
    return { redirectTo: u.toString() };
  },

  /** Internal: MCP and Slack services trade a linked identity for a short-lived API token. */
  'auth.tokenExchange': async (c) => {
    const { ctx, body, service } = c;
    if (body.grant === 'mcp') {
      if (service !== 'mcp') throw new SpinroomError('forbidden', 'Only the MCP service can exchange MCP tokens');
      const claims = await ctx.jwt.verify(body.subjectToken, ctx.cfg.MCP_RESOURCE_URL);
      if (!claims || claims.typ !== 'mcp' || !claims.gid) throw new SpinroomError('unauthenticated', 'Invalid MCP access token');
      const grant = await ctx.db.query.apiTokens.findFirst({ where: eq(apiTokens.id, claims.gid) });
      if (!grant || grant.revokedAt) throw new SpinroomError('unauthenticated', 'This connection was revoked');
      await ctx.db.update(apiTokens).set({ lastUsedAt: ctx.clock.now() }).where(eq(apiTokens.id, grant.id));
      const t = await ctx.jwt.sign({ sub: claims.sub, typ: 'exchange', srf: 'mcp', gid: grant.id }, API_AUDIENCE, EXCHANGE_TTL_SEC);
      return { accessToken: t.token, expiresAt: t.expiresAt, userId: claims.sub };
    }
    if (service !== 'slack') throw new SpinroomError('forbidden', 'Only the Slack service can exchange Slack identities');
    const link = await ctx.db.query.identityLinks.findFirst({
      where: and(eq(identityLinks.provider, 'slack'), eq(identityLinks.teamId, body.teamId), eq(identityLinks.externalId, body.slackUserId)),
    });
    if (!link) throw new SpinroomError('not_member', 'This Slack account isn’t connected to Spinroom yet');
    const user = await ctx.services.users.get(link.userId);
    if (!user) throw new SpinroomError('unauthenticated', 'Account not found');
    const t = await ctx.jwt.sign({ sub: link.userId, typ: 'exchange', srf: 'slack' }, API_AUDIENCE, EXCHANGE_TTL_SEC);
    return { accessToken: t.token, expiresAt: t.expiresAt, userId: link.userId };
  },
};

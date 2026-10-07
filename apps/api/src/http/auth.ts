import { SpinroomError, type Surface } from '@spinroom/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { apiTokens } from '../db/schema.js';
import { safeEqual, sha256 } from '../lib/crypto.js';
import { API_AUDIENCE } from '../lib/jwt.js';

export interface AuthInfo {
  userId: string;
  via: 'cookie' | 'bearer' | 'pat';
  surface: Surface;
  sessionId?: string;
  /** api_tokens id for PATs and MCP grants. */
  tokenId?: string;
}

export type ServiceName = 'slack' | 'mcp';

export const COOKIES = {
  access: 'sr_at',
  refresh: 'sr_rt',
  csrf: 'sr_csrf',
  clientId: 'sr_cid',
} as const;

const SURFACES = new Set<Surface>(['web', 'slack', 'mcp']);

function headerSurface(req: FastifyRequest): Surface | undefined {
  const h = req.headers['x-spinroom-surface'];
  return typeof h === 'string' && SURFACES.has(h as Surface) ? (h as Surface) : undefined;
}

/** Resolve the caller from a bearer token (JWT or PAT) or the session cookie. */
export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<AuthInfo | null> {
  const authz = req.headers.authorization;
  if (authz?.startsWith('Bearer ')) {
    const token = authz.slice(7).trim();
    if (token.startsWith('srp_')) {
      const row = await ctx.db.query.apiTokens.findFirst({
        where: and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)),
      });
      if (!row) throw new SpinroomError('unauthenticated', 'Invalid or revoked token');
      const now = ctx.clock.now();
      if (!row.lastUsedAt || now - row.lastUsedAt > 60_000) {
        await ctx.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id));
      }
      return { userId: row.userId, via: 'pat', surface: headerSurface(req) ?? 'mcp', tokenId: row.id };
    }
    const claims = await ctx.jwt.verify(token, API_AUDIENCE);
    if (!claims) throw new SpinroomError('session_expired', 'Access token expired or invalid');
    if (claims.gid) {
      // Exchanged MCP grant tokens die when the grant is revoked.
      const grant = await ctx.db.query.apiTokens.findFirst({ where: eq(apiTokens.id, claims.gid) });
      if (!grant || grant.revokedAt) throw new SpinroomError('unauthenticated', 'Connection revoked');
    }
    return {
      userId: claims.sub,
      via: 'bearer',
      surface: claims.srf ?? headerSurface(req) ?? 'web',
      ...(claims.sid ? { sessionId: claims.sid } : {}),
      ...(claims.gid ? { tokenId: claims.gid } : {}),
    };
  }
  const cookie = req.cookies[COOKIES.access];
  if (cookie) {
    const claims = await ctx.jwt.verify(cookie, API_AUDIENCE);
    if (!claims) throw new SpinroomError('session_expired', 'Session expired — refresh');
    return { userId: claims.sub, via: 'cookie', surface: 'web', ...(claims.sid ? { sessionId: claims.sid } : {}) };
  }
  return null;
}

/** Internal service credential: `Authorization: Service <secret>`. */
export function authenticateService(ctx: AppContext, req: FastifyRequest): ServiceName | null {
  const authz = req.headers.authorization;
  if (!authz?.startsWith('Service ')) return null;
  const secret = authz.slice(8).trim();
  if (safeEqual(secret, ctx.cfg.SERVICE_SECRET_SLACK)) return 'slack';
  if (safeEqual(secret, ctx.cfg.SERVICE_SECRET_MCP)) return 'mcp';
  return null;
}

/** Double-submit CSRF check for cookie-authenticated writes. */
export function checkCsrf(req: FastifyRequest) {
  const header = req.headers['x-csrf-token'];
  const cookie = req.cookies[COOKIES.csrf];
  if (!cookie || typeof header !== 'string' || !safeEqual(header, cookie)) {
    throw new SpinroomError('csrf_failed', 'Missing or invalid X-CSRF-Token header');
  }
}

export function setSessionCookies(ctx: AppContext, reply: FastifyReply, p: { access: string; accessExpiresAt: number; refresh: string; csrf: string }) {
  const secure = ctx.cfg.COOKIE_SECURE;
  reply.setCookie(COOKIES.access, p.access, { path: '/', httpOnly: true, secure, sameSite: 'lax', expires: new Date(p.accessExpiresAt + 60_000) });
  reply.setCookie(COOKIES.refresh, p.refresh, { path: '/v1/auth', httpOnly: true, secure, sameSite: 'lax', maxAge: 60 * 86400 });
  reply.setCookie(COOKIES.csrf, p.csrf, { path: '/', httpOnly: false, secure, sameSite: 'lax', maxAge: 60 * 86400 });
}

export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(COOKIES.access, { path: '/' });
  reply.clearCookie(COOKIES.refresh, { path: '/v1/auth' });
  reply.clearCookie(COOKIES.csrf, { path: '/' });
}

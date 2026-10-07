import { SpinroomError } from '@spinroom/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { sessions } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';
import { newId, randomToken } from '../lib/ids.js';
import { API_AUDIENCE } from '../lib/jwt.js';

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 60 * 86_400_000;

export interface IssuedSession {
  sessionId: string;
  access: string;
  accessExpiresAt: number;
  refresh: string;
  csrf: string;
}

export function createSessionService(ctx: AppContext) {
  async function mint(userId: string, sessionId: string) {
    return ctx.jwt.sign({ sub: userId, sid: sessionId, typ: 'access' }, API_AUDIENCE, ACCESS_TTL_SEC);
  }

  return {
    async create(userId: string, userAgent?: string): Promise<IssuedSession> {
      const now = ctx.clock.now();
      const sessionId = newId();
      const refresh = randomToken('srr', 32);
      await ctx.db.insert(sessions).values({
        id: sessionId,
        userId,
        refreshHash: sha256(refresh),
        userAgent: userAgent?.slice(0, 200) ?? null,
        createdAt: now,
        expiresAt: now + REFRESH_TTL_MS,
      });
      const { token, expiresAt } = await mint(userId, sessionId);
      return { sessionId, access: token, accessExpiresAt: expiresAt, refresh, csrf: randomToken('csrf', 16) };
    },

    /** Rotate the refresh token (single use) and mint a new access token. */
    async refresh(refreshToken: string): Promise<IssuedSession & { userId: string }> {
      const now = ctx.clock.now();
      const row = await ctx.db.query.sessions.findFirst({ where: and(eq(sessions.refreshHash, sha256(refreshToken)), isNull(sessions.revokedAt)) });
      if (!row || row.expiresAt < now) throw new SpinroomError('session_expired', 'Please sign in again');
      const refresh = randomToken('srr', 32);
      await ctx.db
        .update(sessions)
        .set({ refreshHash: sha256(refresh), expiresAt: now + REFRESH_TTL_MS })
        .where(eq(sessions.id, row.id));
      const { token, expiresAt } = await mint(row.userId, row.id);
      return { userId: row.userId, sessionId: row.id, access: token, accessExpiresAt: expiresAt, refresh, csrf: randomToken('csrf', 16) };
    },

    async revoke(sessionId: string) {
      await ctx.db.update(sessions).set({ revokedAt: ctx.clock.now() }).where(eq(sessions.id, sessionId));
    },

    async revokeAll(userId: string) {
      await ctx.db
        .update(sessions)
        .set({ revokedAt: ctx.clock.now() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    },
  };
}
export type SessionService = ReturnType<typeof createSessionService>;

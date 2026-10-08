import { SpinroomError } from '@spinroom/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { apiTokens } from '../db/schema.js';
import { requireUser, type Handlers } from '../http/router.js';
import { sha256 } from '../lib/crypto.js';
import { humanCode, newId, randomToken } from '../lib/ids.js';

const LINK_CODE_TTL_SEC = 600;

function view(r: typeof apiTokens.$inferSelect) {
  return { id: r.id, label: r.label, scopes: r.scopes, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt };
}

/** Personal access tokens for the stdio MCP server, and one-time link codes. */
export const tokenHandlers: Handlers = {
  'tokens.list': async (c) => {
    const { userId } = requireUser(c);
    const rows = await c.ctx.db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.createdAt));
    return rows.map(view);
  },
  'tokens.create': async (c) => {
    const { userId } = requireUser(c);
    const token = randomToken('srp', 32);
    const [row] = await c.ctx.db
      .insert(apiTokens)
      .values({ id: newId(), userId, tokenHash: sha256(token), kind: 'pat', label: c.body.label, createdAt: c.ctx.clock.now() })
      .returning();
    return { token, apiToken: view(row!) };
  },
  'tokens.revoke': async (c) => {
    const { userId } = requireUser(c);
    const res = await c.ctx.db
      .update(apiTokens)
      .set({ revokedAt: c.ctx.clock.now() })
      .where(and(eq(apiTokens.id, c.params.id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .returning();
    if (!res.length) throw new SpinroomError('not_found', 'Token not found');
    return { ok: true as const };
  },
  'linkCodes.create': async (c) => {
    const { userId } = requireUser(c);
    const code = humanCode();
    await c.ctx.redis.set(`linkcode:${code}`, userId, 'EX', LINK_CODE_TTL_SEC);
    return { code, expiresAt: c.ctx.clock.now() + LINK_CODE_TTL_SEC * 1000 };
  },
  'linkCodes.redeem': async (c) => {
    const code = c.body.code.trim().toUpperCase();
    const userId = await c.ctx.redis.getdel(`linkcode:${code}`);
    if (!userId) throw new SpinroomError('invalid_invite', 'That code expired or was already used — make a new one on the Integrations page (Local server)');
    const user = await c.ctx.services.users.get(userId);
    if (!user) throw new SpinroomError('not_found', 'Account not found');
    const token = randomToken('srp', 32);
    await c.ctx.db.insert(apiTokens).values({ id: newId(), userId, tokenHash: sha256(token), kind: 'pat', label: c.body.label, createdAt: c.ctx.clock.now() });
    return { token, userId, displayName: user.displayName };
  },
};

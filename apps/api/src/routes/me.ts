import { SpinroomError } from '@spinroom/contracts';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { apiTokens, avatars, deletionRequests, identityLinks, users } from '../db/schema.js';
import { clearSessionCookies } from '../http/auth.js';
import { requireUser, type Handlers } from '../http/router.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import { isNull } from 'drizzle-orm';

async function loadMe(ctx: AppContext, userId: string) {
  const u = await ctx.services.users.get(userId);
  if (!u) throw new SpinroomError('unauthenticated', 'Account not found');
  return u;
}

/** Signature the Slack app puts on "Connect Spinroom" links. */
export function slackLinkSignature(secret: string, p: { teamId: string; externalId: string; exp: number }) {
  return hmac(secret, `slack|${p.teamId}|${p.externalId}|${p.exp}`);
}

export const meHandlers: Handlers = {
  'me.get': async (c) => c.ctx.services.users.toMe(await loadMe(c.ctx, requireUser(c).userId)),

  'me.patch': async (c) => {
    const { userId } = requireUser(c);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (c.body.displayName) patch.displayName = c.body.displayName;
    if (c.body.avatarColor) patch.avatarColor = c.body.avatarColor.toUpperCase();
    if (Object.keys(patch).length) await c.ctx.db.update(users).set(patch).where(eq(users.id, userId));
    const me = await loadMe(c.ctx, userId);
    await c.ctx.services.rooms?.onProfileChanged(userId);
    return c.ctx.services.users.toMe(me);
  },

  'me.setAvatar': async (c) => {
    const { userId } = requireUser(c);
    const a = await c.ctx.db.query.avatars.findFirst({ where: eq(avatars.id, c.body.avatarId) });
    if (!a || (a.kind === 'custom' && a.ownerId !== userId) || a.status === 'removed' || a.status === 'rejected') {
      throw new SpinroomError('not_found', 'Avatar not found');
    }
    await c.ctx.db
      .update(users)
      .set({ avatarId: a.id, ...(a.kind === 'preset' ? { presetAvatarId: a.id } : {}) })
      .where(eq(users.id, userId));
    await c.ctx.services.rooms?.onProfileChanged(userId);
    return c.ctx.services.users.toMe(await loadMe(c.ctx, userId));
  },

  'me.spotifyToken': async (c) => {
    const { userId, via } = requireUser(c);
    // Only the user's own speaker page may receive a Spotify token.
    const origin = c.req.headers.origin ?? c.req.headers.referer ?? '';
    if (via !== 'cookie' || !origin.startsWith(c.ctx.cfg.PUBLIC_ORIGIN)) {
      throw new SpinroomError('origin_rejected', 'Spotify tokens are only issued to the Spinroom speaker page');
    }
    const u = await loadMe(c.ctx, userId);
    if (!u.isPremium) throw new SpinroomError('not_premium', 'A Spotify Premium account is needed to run a speaker');
    return c.ctx.services.spotifyTokens.get(userId);
  },

  'me.playlists': async (c) => {
    const { userId } = requireUser(c);
    const { accessToken } = await c.ctx.services.spotifyTokens.get(userId);
    return c.ctx.spotify.listMyPlaylists(accessToken);
  },

  'me.linkIdentity': async (c) => {
    const { userId } = requireUser(c);
    const { teamId, externalId, exp, sig } = c.body;
    if (exp < c.ctx.clock.now()) throw new SpinroomError('invalid_invite', 'This link has expired — press Connect Spinroom again in Slack');
    if (!safeEqual(sig, slackLinkSignature(c.ctx.cfg.SERVICE_SECRET_SLACK, { teamId, externalId, exp }))) {
      throw new SpinroomError('forbidden', 'Invalid link signature');
    }
    await c.ctx.db
      .insert(identityLinks)
      .values({ userId, provider: 'slack', teamId, externalId, createdAt: c.ctx.clock.now() })
      .onConflictDoUpdate({ target: [identityLinks.provider, identityLinks.teamId, identityLinks.externalId], set: { userId } });
    return { ok: true as const };
  },

  'me.unlinkIdentity': async (c) => {
    const { userId } = requireUser(c);
    await c.ctx.db.delete(identityLinks).where(and(eq(identityLinks.userId, userId), eq(identityLinks.provider, c.params.provider)));
    if (c.params.provider === 'mcp') {
      await c.ctx.db
        .update(apiTokens)
        .set({ revokedAt: c.ctx.clock.now() })
        .where(and(eq(apiTokens.userId, userId), eq(apiTokens.kind, 'mcp_oauth'), isNull(apiTokens.revokedAt)));
    }
    return { ok: true as const };
  },

  'me.delete': async (c) => {
    const { userId } = requireUser(c);
    const now = c.ctx.clock.now();
    await c.ctx.services.rooms?.onAccountDeleted(userId);
    // Immediate: revoke access and scrub identifying fields. The deletion worker purges the rest.
    await c.ctx.db
      .update(users)
      .set({ deletedAt: now, displayName: 'Deleted user', email: null, spotifyClientId: null, spotifyUserId: `deleted:${userId}` })
      .where(eq(users.id, userId));
    await c.ctx.services.spotifyTokens.remove(userId);
    await c.ctx.services.sessions.revokeAll(userId);
    await c.ctx.db.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.userId, userId));
    await c.ctx.db.delete(identityLinks).where(eq(identityLinks.userId, userId));
    await c.ctx.db.insert(deletionRequests).values({ userId, requestedAt: now }).onConflictDoNothing();
    clearSessionCookies(c.reply);
    return { ok: true as const, completesBy: now + 30 * 86_400_000 };
  },
};

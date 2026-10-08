import { SpinroomError } from '@spinroom/contracts';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { apiTokens, avatars, deletionRequests, identityLinks, users } from '../db/schema.js';
import { clearSessionCookies } from '../http/auth.js';
import { requireUser, type Handlers } from '../http/router.js';
import { hmac, safeEqual, sha256 } from '../lib/crypto.js';
import { processPhoto } from '../lib/photo.js';
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

async function dropPhoto(ctx: AppContext, key: string | null) {
  if (key) await ctx.storage.delete(key).catch((err) => ctx.log.warn({ err, key }, 'photo delete failed'));
}

export const meHandlers: Handlers = {
  'me.setPhoto': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, req } = c;
    if (!req.isMultipart()) throw new SpinroomError('bad_request', 'Send the photo as multipart/form-data');
    const part = await req.file();
    if (!part) throw new SpinroomError('bad_request', 'No photo uploaded');
    const input = await part.toBuffer();
    if (part.file.truncated) throw new SpinroomError('payload_too_large', 'Photos are limited to 10 MB');
    const webp = await processPhoto(input);
    // Per-user keys, so removing a photo never touches anyone else's.
    const key = `photos/${userId}/${sha256(webp).slice(0, 32)}.webp`;
    await ctx.storage.put(key, webp, 'image/webp');
    const before = await loadMe(ctx, userId);
    await ctx.db.update(users).set({ photoKey: key }).where(eq(users.id, userId));
    if (before.photoKey && before.photoKey !== key) await dropPhoto(ctx, before.photoKey);
    return ctx.services.users.toMe(await loadMe(ctx, userId));
  },

  'me.deletePhoto': async (c) => {
    const { userId } = requireUser(c);
    const before = await loadMe(c.ctx, userId);
    await c.ctx.db.update(users).set({ photoKey: null }).where(eq(users.id, userId));
    await dropPhoto(c.ctx, before.photoKey);
    return c.ctx.services.users.toMe(await loadMe(c.ctx, userId));
  },

  'me.get': async (c) => {
    const u = await loadMe(c.ctx, requireUser(c).userId);
    if (!u.isPremium) {
      // Premium only (see completeLogin): end any session a Free account still has.
      await c.ctx.services.sessions.revokeAll(u.id);
      clearSessionCookies(c.reply);
      throw new SpinroomError('unauthenticated', 'Spinroom needs a Spotify Premium account — please sign in with one');
    }
    return c.ctx.services.users.toMe(u);
  },

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
    await dropPhoto(c.ctx, (await loadMe(c.ctx, userId)).photoKey);
    // Immediate: revoke access and scrub identifying fields. The deletion worker purges the rest.
    await c.ctx.db
      .update(users)
      .set({ deletedAt: now, displayName: 'Deleted user', email: null, photoKey: null, spotifyClientId: null, spotifyUserId: `deleted:${userId}` })
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

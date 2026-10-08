import { AVATAR_COLORS, DEFAULT_PRESET_ID, PRESET_AVATARS, RUNTIME_SHEET, type AvatarRef, type Avatar, type Me, type PublicUser } from '@spinroom/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { apiTokens, avatars, identityLinks, users } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { SpotifyProfile } from '../spotify/gateway.js';

export type UserRow = typeof users.$inferSelect;
export type AvatarRow = typeof avatars.$inferSelect;

export function avatarRef(ctx: AppContext, a: AvatarRow): AvatarRef {
  const url = (u: string) => (u.startsWith('/') || u.startsWith('http') ? u : ctx.storage.url(u));
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    sheetUrl: url(a.sheetUrl),
    thumbUrl: url(a.thumbUrl),
    rows: a.rows.map((r) => ({
      state: r.state as AvatarRef['rows'][number]['state'],
      frames: r.frames,
      ...(r.dimmed ? { dimmed: true } : {}),
      ...(r.at !== undefined ? { at: r.at } : {}),
    })),
    cell: { w: RUNTIME_SHEET.cellW, h: RUNTIME_SHEET.cellH },
  };
}

export function avatarFull(ctx: AppContext, a: AvatarRow): Avatar {
  return { ...avatarRef(ctx, a), ownerId: a.ownerId, status: a.status, sourceFormat: a.sourceFormat, featured: a.featured, createdAt: a.createdAt };
}

export function createUserService(ctx: AppContext) {
  const avatarCache = new Map<string, { row: AvatarRow; at: number }>();

  async function getAvatar(id: string): Promise<AvatarRow | null> {
    const hit = avatarCache.get(id);
    if (hit && ctx.clock.now() - hit.at < 30_000) return hit.row;
    const row = (await ctx.db.query.avatars.findFirst({ where: eq(avatars.id, id) })) ?? null;
    if (row) avatarCache.set(id, { row, at: ctx.clock.now() });
    return row;
  }

  /**
   * The avatar others see: a custom avatar only once approved (FR-A13) and not hidden by
   * the room's moderators (FR-A15); otherwise the member's preset.
   */
  async function visibleAvatar(u: UserRow, opts: { hidden?: boolean; viewerId?: string | null } = {}): Promise<AvatarRef> {
    const a = await getAvatar(u.avatarId);
    const ownView = opts.viewerId === u.id;
    if (a && (a.kind === 'preset' || (a.status === 'approved' && !opts.hidden) || (ownView && a.status === 'pending' && !opts.hidden))) {
      return avatarRef(ctx, a);
    }
    const preset = (await getAvatar(u.presetAvatarId)) ?? (await getAvatar(DEFAULT_PRESET_ID));
    return avatarRef(ctx, preset!);
  }

  return {
    invalidateAvatar(id: string) {
      avatarCache.delete(id);
    },
    getAvatar,
    visibleAvatar,

    async get(id: string): Promise<UserRow | null> {
      return (await ctx.db.query.users.findFirst({ where: and(eq(users.id, id), isNull(users.deletedAt)) })) ?? null;
    },

    async getMany(ids: string[]): Promise<Map<string, UserRow>> {
      if (!ids.length) return new Map();
      const rows = await ctx.db
        .select()
        .from(users)
        .where(inArray(users.id, [...new Set(ids)]));
      return new Map(rows.map((r) => [r.id, r]));
    },

    async upsertFromSpotify(profile: SpotifyProfile, clientId: string | null): Promise<{ user: UserRow; created: boolean }> {
      const now = ctx.clock.now();
      const isPremium = profile.product === 'premium';
      const isAdmin = ctx.cfg.ADMIN_SPOTIFY_IDS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(profile.id);
      const existing = await ctx.db.query.users.findFirst({ where: eq(users.spotifyUserId, profile.id) });
      if (existing) {
        const [user] = await ctx.db
          .update(users)
          .set({
            isPremium,
            isAdmin: isAdmin || existing.isAdmin,
            email: profile.email,
            ...(clientId ? { spotifyClientId: clientId } : {}),
            deletedAt: null,
          })
          .where(eq(users.id, existing.id))
          .returning();
        return { user: user!, created: false };
      }
      const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
      const preset = PRESET_AVATARS[Math.floor(Math.random() * PRESET_AVATARS.length)]!.id;
      const [user] = await ctx.db
        .insert(users)
        .values({
          id: newId(),
          spotifyUserId: profile.id,
          spotifyClientId: clientId,
          displayName: profile.displayName.slice(0, 40) || profile.id,
          email: profile.email,
          avatarColor: color,
          avatarId: preset,
          presetAvatarId: preset,
          isPremium,
          isAdmin,
          createdAt: now,
        })
        .returning();
      return { user: user!, created: true };
    },

    async toPublic(u: UserRow, opts: { hidden?: boolean; viewerId?: string | null } = {}): Promise<PublicUser> {
      return {
        id: u.id,
        displayName: u.displayName,
        avatar: await visibleAvatar(u, opts),
        avatarColor: u.avatarColor,
        points: u.points,
      };
    },

    async toMe(u: UserRow): Promise<Me> {
      const links = await ctx.db.select({ provider: identityLinks.provider }).from(identityLinks).where(eq(identityLinks.userId, u.id));
      const mcpTokens = await ctx.db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, u.id), isNull(apiTokens.revokedAt)))
        .limit(1);
      const own = await getAvatar(u.avatarId);
      return {
        id: u.id,
        displayName: u.displayName,
        avatar: own ? avatarRef(ctx, own) : await visibleAvatar(u),
        avatarColor: u.avatarColor,
        points: u.points,
        spotifyUserId: u.spotifyUserId,
        spotifyClientId: u.spotifyClientId,
        email: u.email,
        isPremium: u.isPremium,
        remoteOnly: !u.isPremium,
        isAdmin: u.isAdmin,
        photoUrl: u.photoKey ? ctx.storage.url(u.photoKey) : null,
        uploadRevoked: u.uploadRevoked,
        connections: { slack: links.some((l) => l.provider === 'slack'), mcp: links.some((l) => l.provider === 'mcp') || mcpTokens.length > 0 },
        createdAt: u.createdAt,
      };
    },
  };
}
export type UserService = ReturnType<typeof createUserService>;

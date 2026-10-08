import { DEFAULT_ROOM_SETTINGS, RoomSettingsSchema, SpinroomError, type Invite, type RoomSummary } from '@spinroom/contracts';
import { and, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { invites, roomMembers, rooms, spins, users } from '../db/schema.js';
import type { AuthInfo } from '../http/auth.js';
import { requireUser, type Handlers } from '../http/router.js';
import { sha256 } from '../lib/crypto.js';
import { newId, randomToken } from '../lib/ids.js';
import { LIVE_TICKET_TTL_MS, liveTicketKey } from '../rooms/live-ticket.js';
import { assertCanView, assertMod, ensureMember, isMod, memberRow, roomBySlug, roomSettings, toRoom, type RoomRow } from '../rooms/access.js';
import type { RoomLiveSummary } from '../rooms/snapshot.js';

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s.length >= 2 ? s : `room-${Math.random().toString(36).slice(2, 7)}`;
}

/** FR-L2: Slack and MCP actions keep the member present as a remote for 15 minutes. */
export async function touchRemote(ctx: AppContext, auth: AuthInfo, room: RoomRow) {
  if (auth.surface === 'web') return;
  const m = await memberRow(ctx, room.id, auth.userId);
  await ctx.services.rooms.exec(room.id, { type: 'remoteAction', userId: auth.userId, role: m?.role ?? 'member' });
}

export function inviteUrl(ctx: AppContext, token: string) {
  return `${ctx.cfg.PUBLIC_ORIGIN}/invite/${token}`;
}

async function createInvite(ctx: AppContext, room: RoomRow, userId: string, expiresInMs: number | null | undefined): Promise<Invite> {
  const token = randomToken('inv', 18);
  const now = ctx.clock.now();
  const ttl = expiresInMs === undefined ? roomSettings(room).inviteTtlMs : expiresInMs;
  const row = {
    id: newId(),
    roomId: room.id,
    tokenHash: sha256(token),
    createdBy: userId,
    createdAt: now,
    expiresAt: ttl === null ? null : now + ttl,
  };
  await ctx.db.insert(invites).values(row);
  const url = inviteUrl(ctx, token);
  return {
    id: row.id,
    roomId: room.id,
    url,
    token,
    expiresAt: row.expiresAt,
    revokedAt: null,
    uses: 0,
    message: `Come DJ with me in “${room.name}” on Spinroom: ${url}`,
  };
}

/** FR-R2: signed invite tokens (hash stored), expiring and revocable. */
export async function validInvite(ctx: AppContext, token: string) {
  const row = await ctx.db.query.invites.findFirst({ where: eq(invites.tokenHash, sha256(token)) });
  if (!row || row.revokedAt || (row.expiresAt !== null && row.expiresAt < ctx.clock.now())) {
    throw new SpinroomError('invalid_invite', 'This invite link has expired or was revoked');
  }
  return row;
}

async function acceptInvite(ctx: AppContext, token: string, userId: string): Promise<RoomRow> {
  const inv = await validInvite(ctx, token);
  const room = await ctx.db.query.rooms.findFirst({ where: eq(rooms.id, inv.roomId) });
  if (!room) throw new SpinroomError('invalid_invite', 'That room no longer exists');
  const existing = await memberRow(ctx, room.id, userId);
  if (existing?.banned) throw new SpinroomError('banned', 'You were banned from this room');
  if (!existing) {
    await ctx.db.insert(roomMembers).values({ roomId: room.id, userId, role: 'member', joinedAt: ctx.clock.now() }).onConflictDoNothing();
    await ctx.db
      .update(invites)
      .set({ uses: inv.uses + 1 })
      .where(eq(invites.id, inv.id));
  }
  return room;
}

function summaryOf(r: RoomRow, live: RoomLiveSummary | undefined, myRole: RoomSummary['myRole']): RoomSummary {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    ownerId: r.ownerId,
    listeners: live?.listeners ?? 0,
    liveSpeakers: live?.liveSpeakers ?? 0,
    status: live?.status ?? 'idle',
    nowPlaying: live?.nowPlaying ?? null,
    myRole,
  };
}

export const roomHandlers: Handlers = {
  'rooms.list': async ({ ctx, query, auth }) => {
    let rows: RoomRow[];
    const roles = new Map<string, RoomSummary['myRole']>();
    if (query.filter === 'mine') {
      const { userId } = requireUser({ auth });
      const ms = await ctx.db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.userId, userId), eq(roomMembers.banned, false)));
      for (const m of ms) roles.set(m.roomId, m.role);
      rows = ms.length
        ? await ctx.db
            .select()
            .from(rooms)
            .where(
              inArray(
                rooms.id,
                ms.map((m) => m.roomId),
              ),
            )
        : [];
    } else {
      const conds = [eq(rooms.visibility, 'public' as const)];
      if (query.q) conds.push(or(ilike(rooms.name, `%${query.q}%`), ilike(rooms.description, `%${query.q}%`))!);
      rows = await ctx.db
        .select()
        .from(rooms)
        .where(and(...conds))
        .orderBy(desc(rooms.createdAt))
        .limit(500);
      if (auth && rows.length) {
        const ms = await ctx.db
          .select()
          .from(roomMembers)
          .where(
            and(
              eq(roomMembers.userId, auth.userId),
              inArray(
                roomMembers.roomId,
                rows.map((r) => r.id),
              ),
            ),
          );
        for (const m of ms) roles.set(m.roomId, m.role);
      }
    }
    if (query.q && query.filter === 'mine') rows = rows.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(query.q!.toLowerCase()));
    const live = await ctx.services.rooms.summaries(rows.map((r) => r.id));
    const all = rows
      .map((r) => summaryOf(r, live.get(r.id), roles.get(r.id) ?? null))
      .sort((a, b) => b.listeners - a.listeners || (a.status === 'playing' ? -1 : 0) - (b.status === 'playing' ? -1 : 0));
    return { rooms: all.slice(query.offset, query.offset + query.limit), total: all.length };
  },

  'rooms.create': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, body } = c;
    const settings = RoomSettingsSchema.parse({ ...DEFAULT_ROOM_SETTINGS, ...(body.settings ?? {}) });
    let slug = body.slug ?? slugify(body.name);
    if (body.slug) {
      if (await ctx.db.query.rooms.findFirst({ where: eq(rooms.slug, slug) })) throw new SpinroomError('slug_taken', `“${slug}” is taken — try another`);
    } else {
      const base = slug;
      for (let i = 2; await ctx.db.query.rooms.findFirst({ where: eq(rooms.slug, slug) }); i++) slug = `${base}-${i}`;
    }
    const now = ctx.clock.now();
    const [room] = await ctx.db
      .insert(rooms)
      .values({
        id: newId(),
        slug,
        name: body.name,
        description: body.description,
        ownerId: userId,
        visibility: body.visibility,
        settingsJson: settings,
        createdAt: now,
      })
      .returning();
    await ctx.db.insert(roomMembers).values({ roomId: room!.id, userId, role: 'owner', joinedAt: now });
    ctx.services.analytics.track('room_created', { userId, roomId: room!.id, props: { visibility: body.visibility } });
    return { room: toRoom(room!), invite: await createInvite(ctx, room!, userId, undefined) };
  },

  'rooms.get': async ({ ctx, params, auth }) => {
    const room = await roomBySlug(ctx, params.slug);
    await assertCanView(ctx, room, auth?.userId ?? null);
    return ctx.services.rooms.snapshot(room, auth?.userId ?? null);
  },

  'rooms.patch': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, params, body } = c;
    const room = await roomBySlug(ctx, params.slug);
    await assertMod(ctx, room, userId);
    const settings = RoomSettingsSchema.parse({ ...roomSettings(room), ...(body.settings ?? {}) });
    const [updated] = await ctx.db
      .update(rooms)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.visibility ? { visibility: body.visibility } : {}),
        settingsJson: settings,
      })
      .where(eq(rooms.id, room.id))
      .returning();
    await ctx.services.rooms.settingsChanged(updated!, settings);
    return toRoom(updated!);
  },

  'rooms.join': async (c) => {
    const auth = requireUser(c);
    const { ctx, params, body } = c;
    let room = await roomBySlug(ctx, params.slug);
    if (body.invite) {
      const r = await acceptInvite(ctx, body.invite.replace(/^.*\/invite\//, ''), auth.userId);
      if (r.id !== room.id) throw new SpinroomError('invalid_invite', 'That invite is for a different room');
      room = r;
    }
    await ensureMember(ctx, room, auth.userId);
    await touchRemote(ctx, auth, room);
    ctx.services.analytics.track('room_joined', { userId: auth.userId, roomId: room.id, props: { surface: auth.surface } });
    return ctx.services.rooms.snapshot(room, auth.userId);
  },

  'rooms.leave': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await c.ctx.services.rooms.exec(room.id, { type: 'leave', userId });
    return { ok: true as const };
  },

  'rooms.liveTicket': async (c) => {
    const auth = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await assertCanView(c.ctx, room, auth.userId);
    const ticket = randomToken('swt', 32);
    const expiresAt = c.ctx.clock.now() + LIVE_TICKET_TTL_MS;
    await c.ctx.redis.set(liveTicketKey(ticket), JSON.stringify({ auth, roomId: room.id }), 'PX', LIVE_TICKET_TTL_MS);
    return { ticket, expiresAt };
  },

  'rooms.members': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await assertMod(c.ctx, room, userId);
    const rows = await c.ctx.db
      .select({ m: roomMembers, name: users.displayName })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(eq(roomMembers.roomId, room.id));
    return rows.map(({ m, name }) => ({ userId: m.userId, displayName: name, role: m.role, banned: m.banned, muted: m.muted, lastSeenAt: m.lastSeenAt }));
  },

  'rooms.history': async ({ ctx, params, query, auth }) => {
    const room = await roomBySlug(ctx, params.slug);
    await assertCanView(ctx, room, auth?.userId ?? null);
    const rows = await ctx.db
      .select({ s: spins, name: users.displayName })
      .from(spins)
      .leftJoin(users, eq(users.id, spins.djUserId))
      .where(and(eq(spins.roomId, room.id)))
      .orderBy(desc(spins.startedAt))
      .limit(query.limit);
    return rows.map(({ s, name }) => ({
      id: s.id,
      djUserId: s.djUserId,
      djName: name ?? 'Unknown',
      track: {
        uri: s.trackUri,
        title: s.title,
        artists: s.artists,
        album: s.album,
        artUrl: s.artUrl,
        durationMs: s.durationMs,
        explicit: s.explicit,
        playable: true,
      },
      startedAtServerMs: s.startedAt,
      durationMs: s.durationMs,
      endedAt: s.endedAt,
      endReason: s.endReason,
      hype: s.hypeCount,
      skip: s.skipCount,
      eligibleVoters: s.eligibleVoters,
    }));
  },

  // ---------------------------------------------------------------- invites
  'invites.create': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    const m = await assertCanView(c.ctx, room, userId);
    if (!m && room.visibility === 'invite_only') throw new SpinroomError('not_member', 'Only members can invite');
    await ensureMember(c.ctx, room, userId);
    return createInvite(c.ctx, room, userId, c.body.expiresInMs);
  },

  'invites.list': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await assertMod(c.ctx, room, userId);
    const rows = await c.ctx.db
      .select()
      .from(invites)
      .where(and(eq(invites.roomId, room.id), isNull(invites.revokedAt)))
      .orderBy(desc(invites.createdAt));
    const now = c.ctx.clock.now();
    // Only token hashes are stored, so listed invites can be revoked but not re-shared.
    return rows
      .filter((r) => r.expiresAt === null || r.expiresAt > now)
      .map((r) => ({ id: r.id, roomId: r.roomId, url: '', expiresAt: r.expiresAt, revokedAt: r.revokedAt, uses: r.uses, message: '' }));
  },

  'invites.revoke': async (c) => {
    const { userId } = requireUser(c);
    const inv = await c.ctx.db.query.invites.findFirst({ where: eq(invites.id, c.params.id) });
    if (!inv) throw new SpinroomError('not_found', 'Invite not found');
    if (inv.createdBy !== userId) {
      const m = await memberRow(c.ctx, inv.roomId, userId);
      if (!isMod(m?.role)) throw new SpinroomError('forbidden', 'Only the creator or a moderator can revoke this invite');
    }
    await c.ctx.db.update(invites).set({ revokedAt: c.ctx.clock.now() }).where(eq(invites.id, inv.id));
    return { ok: true as const };
  },

  'invites.preview': async ({ ctx, params }) => {
    const inv = await validInvite(ctx, params.token);
    const room = await ctx.db.query.rooms.findFirst({ where: eq(rooms.id, inv.roomId) });
    if (!room) throw new SpinroomError('invalid_invite', 'That room no longer exists');
    const live = await ctx.services.rooms.summaries([room.id]);
    return { room: summaryOf(room, live.get(room.id), null), expiresAt: inv.expiresAt };
  },

  'invites.accept': async (c) => {
    const { userId } = requireUser(c);
    const room = await acceptInvite(c.ctx, c.params.token, userId);
    return { room: toRoom(room) };
  },
};

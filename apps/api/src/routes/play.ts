import { SpinroomError, TIMING, type Track } from '@spinroom/contracts';
import { isEligible, tally } from '@spinroom/room-engine';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { chatMessages, roomMembers, speakers } from '../db/schema.js';
import { requireUser, type Handlers } from '../http/router.js';
import { newId } from '../lib/ids.js';
import { hitRateLimit } from '../lib/ratelimit.js';
import { assertCanView, assertMod, ensureMember, isMod, memberRow, roomBySlug, roomSettings, type RoomRow } from '../rooms/access.js';
import { chatView, membersView } from '../rooms/snapshot.js';
import { touchRemote } from './rooms.js';

/** Keep the engine's copy of a set fresh when it matters (booth or queue). */
async function syncSet(ctx: AppContext, room: RoomRow, userId: string) {
  const state = await ctx.services.rooms.load(room.id);
  if (state.booth.some((b) => b.userId === userId) || state.queue.some((q) => q.userId === userId) || state.sets[userId]) {
    await ctx.services.rooms.exec(room.id, { type: 'setUpdated', userId, preview: await ctx.services.rooms.sets.preview(room.id, userId) });
  }
}

async function publishMember(ctx: AppContext, roomId: string, userId: string) {
  const state = await ctx.services.rooms.load(roomId);
  const [view] = await membersView(ctx, roomId, state, [userId]);
  if (view)
    await ctx.services.rooms.publish(roomId, [
      { type: 'presence.changed', userId, state: view.presence, eligible: view.eligible, member: view, avatar: view.user.avatar },
    ]);
}

/** Control and bidi-override characters stripped from chat. */
// eslint-disable-next-line no-control-regex
const CHAT_STRIP = /[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

/** Strip control characters (chat is plain text; clients never render it as HTML). */
export function cleanChat(text: string): string {
  return text.replace(CHAT_STRIP, '').trim().slice(0, TIMING.chatMaxLength);
}

const SEARCH_TTL_SEC = 600;

export const playHandlers: Handlers = {
  // ---------------------------------------------------------------- set ("My set")
  'crate.get': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await ensureMember(c.ctx, room, userId);
    return c.ctx.services.rooms.sets.view(room, userId);
  },
  'crate.add': async (c) => {
    const auth = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await ensureMember(c.ctx, room, auth.userId);
    const crate = await c.ctx.services.rooms.sets.add(room, auth.userId, {
      ...(c.body.trackUri ? { trackUri: c.body.trackUri } : {}),
      ...(c.body.query ? { query: c.body.query } : {}),
    });
    await syncSet(c.ctx, room, auth.userId);
    await touchRemote(c.ctx, auth, room);
    return crate;
  },
  'crate.move': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    const crate = await c.ctx.services.rooms.sets.move(room, userId, c.params.itemId, c.body.position);
    await syncSet(c.ctx, room, userId);
    return crate;
  },
  'crate.remove': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    const crate = await c.ctx.services.rooms.sets.remove(room, userId, c.params.itemId);
    await syncSet(c.ctx, room, userId);
    return crate;
  },
  'crate.import': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await ensureMember(c.ctx, room, userId);
    const crate = await c.ctx.services.rooms.sets.importPlaylist(room, userId, c.body.mode, c.body.playlist);
    await syncSet(c.ctx, room, userId);
    return crate;
  },

  // ---------------------------------------------------------------- DJ queue
  'djQueue.join': async (c) => {
    const auth = requireUser(c);
    const { ctx } = c;
    const room = await roomBySlug(ctx, c.params.slug);
    const m = await ensureMember(ctx, room, auth.userId);
    const u = await ctx.services.users.get(auth.userId);
    if (!u?.isPremium) throw new SpinroomError('not_premium', 'DJing needs Spotify Premium — Free accounts can listen in as remotes and vote');
    await ctx.services.rooms.sets.refresh(room.id, auth.userId).catch((e) => ctx.log.warn({ err: e }, 'set refresh before queue join failed'));
    const preview = await ctx.services.rooms.sets.preview(room.id, auth.userId);
    const cmds = [
      ...(auth.surface !== 'web' ? [{ type: 'remoteAction' as const, userId: auth.userId, role: m.role }] : []),
      { type: 'setUpdated' as const, userId: auth.userId, preview },
      { type: 'queueJoin' as const, userId: auth.userId },
    ];
    const { state } = await ctx.services.rooms.exec(room.id, cmds);
    const slot = state.booth.findIndex((b) => b.userId === auth.userId);
    const pos = state.queue.findIndex((q) => q.userId === auth.userId);
    return { boothSlot: slot >= 0 ? slot : null, queuePosition: pos >= 0 ? pos + 1 : null };
  },
  'djQueue.leave': async (c) => {
    const auth = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await c.ctx.services.rooms.exec(room.id, { type: 'queueLeave', userId: auth.userId });
    await touchRemote(c.ctx, auth, room);
    return { ok: true as const };
  },

  // ---------------------------------------------------------------- spins
  'spins.vote': async (c) => {
    const auth = requireUser(c);
    const { ctx } = c;
    const room = await roomBySlug(ctx, c.params.slug);
    const m = await ensureMember(ctx, room, auth.userId);
    const { state } = await ctx.services.rooms.exec(room.id, [
      ...(auth.surface !== 'web' ? [{ type: 'remoteAction' as const, userId: auth.userId, role: m.role }] : []),
      { type: 'vote' as const, userId: auth.userId, spinId: c.params.spinId, value: c.body.value, surface: auth.surface },
    ]);
    const spinId = state.current?.id ?? c.params.spinId;
    const t = tally(state, ctx.clock.now());
    const me = state.members[auth.userId];
    return {
      spinId,
      tally: { hype: t.hype, skip: t.skip, eligibleVoters: t.eligibleVoters },
      myVote: state.current?.votes[auth.userId]?.value ?? null,
      counted: Boolean(me && isEligible(me, state.settings, ctx.clock.now())),
    };
  },
  'spins.skip': async (c) => {
    const auth = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    const state = await c.ctx.services.rooms.load(room.id);
    if (!state.current) throw new SpinroomError('spin_not_current', 'Nothing is playing');
    let by: 'dj' | 'mod' = 'dj';
    if (state.current.djUserId !== auth.userId) {
      const m = await memberRow(c.ctx, room.id, auth.userId);
      if (!isMod(m?.role)) throw new SpinroomError('forbidden', 'Only the DJ or a moderator can skip this spin');
      by = 'mod';
    }
    await c.ctx.services.rooms.exec(room.id, { type: 'skip', userId: auth.userId, by });
    await touchRemote(c.ctx, auth, room);
    return { ok: true as const };
  },
  'spins.votes': async (c) => {
    const { userId } = requireUser(c);
    const room = await roomBySlug(c.ctx, c.params.slug);
    await assertMod(c.ctx, room, userId);
    const state = await c.ctx.services.rooms.load(room.id);
    return Object.entries(state.current?.votes ?? {}).map(([uid, v]) => ({ userId: uid, value: v.value, surface: v.surface }));
  },

  // ---------------------------------------------------------------- chat
  'chat.send': async (c) => {
    const auth = requireUser(c);
    const { ctx } = c;
    const room = await roomBySlug(ctx, c.params.slug);
    const m = await ensureMember(ctx, room, auth.userId);
    if (m.muted) throw new SpinroomError('muted', 'A moderator muted your chat in this room');
    const s = roomSettings(room);
    const wait = await hitRateLimit(ctx.redis, `chat:${room.id}:${auth.userId}`, s.chatMaxMessages, s.chatWindowMs, ctx.clock.now());
    if (wait > 0) throw new SpinroomError('rate_limited', 'You’re sending messages too fast', { retryAfterMs: wait });
    const text = cleanChat(c.body.text);
    if (!text) throw new SpinroomError('validation_failed', 'Message is empty');
    const [row] = await ctx.db.insert(chatMessages).values({ id: newId(), roomId: room.id, userId: auth.userId, text, createdAt: ctx.clock.now() }).returning();
    const message = chatView(row!);
    await ctx.services.rooms.publish(room.id, [{ type: 'chat.message', message }]);
    await touchRemote(ctx, auth, room);
    return message;
  },
  'chat.list': async ({ ctx, params, query, auth }) => {
    const room = await roomBySlug(ctx, params.slug);
    await assertCanView(ctx, room, auth?.userId ?? null);
    const rows = await ctx.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.roomId, room.id), ...(query.before ? [lt(chatMessages.createdAt, query.before)] : [])))
      .orderBy(desc(chatMessages.createdAt))
      .limit(query.limit);
    return rows.reverse().map(chatView);
  },
  'chat.react': async (c) => {
    const { userId } = requireUser(c);
    const { ctx } = c;
    const room = await roomBySlug(ctx, c.params.slug);
    await ensureMember(ctx, room, userId);
    const emoji = c.body.emoji.trim();
    if (!/\p{Extended_Pictographic}/u.test(emoji) || /\s/.test(emoji)) throw new SpinroomError('validation_failed', 'Reactions must be a single emoji');
    const msg = await ctx.db.query.chatMessages.findFirst({ where: and(eq(chatMessages.id, c.params.messageId), eq(chatMessages.roomId, room.id)) });
    if (!msg) throw new SpinroomError('not_found', 'Message not found');
    const reactions = { ...msg.reactions };
    const list = new Set(reactions[emoji] ?? []);
    if (list.has(userId)) list.delete(userId);
    else list.add(userId);
    if (list.size) reactions[emoji] = [...list];
    else delete reactions[emoji];
    if (Object.keys(reactions).length > 20) throw new SpinroomError('validation_failed', 'Too many different reactions on this message');
    await ctx.db.update(chatMessages).set({ reactions }).where(eq(chatMessages.id, msg.id));
    await ctx.services.rooms.publish(room.id, [{ type: 'chat.reaction', messageId: msg.id, reactions }]);
    return { reactions };
  },

  // ---------------------------------------------------------------- moderation (FR-R3, FR-A15)
  'rooms.moderate': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, body } = c;
    const room = await roomBySlug(ctx, c.params.slug);
    const me = await assertMod(ctx, room, userId);
    const rooms = ctx.services.rooms;
    if (body.action === 'end_spin') {
      await rooms.exec(room.id, { type: 'skip', userId, by: 'mod' });
      return { ok: true as const };
    }
    if (!body.userId) throw new SpinroomError('validation_failed', 'userId is required');
    const target = await memberRow(ctx, room.id, body.userId);
    if (!target) throw new SpinroomError('not_found', 'That person isn’t a member of this room');
    if (target.role === 'owner') throw new SpinroomError('forbidden', 'The room owner can’t be moderated');
    if (target.role === 'moderator' && me.role !== 'owner') throw new SpinroomError('forbidden', 'Only the owner can moderate moderators');
    const set = (patch: Partial<typeof roomMembers.$inferInsert>) =>
      ctx.db
        .update(roomMembers)
        .set(patch)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, body.userId!)));
    switch (body.action) {
      case 'kick':
        await rooms.exec(room.id, { type: 'leave', userId: body.userId, kicked: true });
        break;
      case 'ban':
        await set({ banned: true });
        await rooms.exec(room.id, { type: 'leave', userId: body.userId, kicked: true });
        break;
      case 'unban':
        await set({ banned: false });
        break;
      case 'mute':
      case 'unmute':
        await set({ muted: body.action === 'mute' });
        await publishMember(ctx, room.id, body.userId);
        break;
      case 'set_role':
        if (me.role !== 'owner') throw new SpinroomError('forbidden', 'Only the owner can change roles');
        if (!body.role) throw new SpinroomError('validation_failed', 'role is required');
        await set({ role: body.role });
        await rooms.exec(room.id, { type: 'roleChanged', userId: body.userId, role: body.role });
        await publishMember(ctx, room.id, body.userId);
        break;
      case 'hide_avatar':
      case 'unhide_avatar':
        await set({ avatarHidden: body.action === 'hide_avatar' });
        await publishMember(ctx, room.id, body.userId);
        break;
      case 'remove_from_booth':
        await rooms.exec(room.id, { type: 'removeFromBooth', userId: body.userId });
        break;
    }
    return { ok: true as const };
  },

  // ---------------------------------------------------------------- search
  'search.tracks': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, query } = c;
    const key = `search:${query.limit}:${query.q.trim().toLowerCase()}`;
    const hit = await ctx.redis.get(key);
    if (hit) return JSON.parse(hit) as Track[];
    const { accessToken } = await ctx.services.spotifyTokens.get(userId);
    const tracks = await ctx.spotify.searchTracks(accessToken, query.q, query.limit);
    await ctx.redis.set(key, JSON.stringify(tracks), 'EX', SEARCH_TTL_SEC);
    return tracks;
  },

  // ---------------------------------------------------------------- speakers (Phase 3)
  'speakers.register': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, body } = c;
    const room = await roomBySlug(ctx, body.roomSlug);
    await ensureMember(ctx, room, userId);
    const u = await ctx.services.users.get(userId);
    if (!u?.isPremium) throw new SpinroomError('not_premium', 'A speaker needs Spotify Premium. Free accounts can listen in as remotes.');
    const now = ctx.clock.now();
    const open = await ctx.db
      .select()
      .from(speakers)
      .where(and(eq(speakers.roomId, room.id), eq(speakers.userId, userId), isNull(speakers.closedAt)));
    const live = open.filter((s) => s.lastHeartbeatAt && now - s.lastHeartbeatAt <= TIMING.speakerLiveMs);
    if (live.length && !body.takeover) {
      throw new SpinroomError('speaker_exists', 'You already have a speaker playing this room — move it here?', { speakerId: live[0]!.id });
    }
    if (open.length) {
      await ctx.db
        .update(speakers)
        .set({ closedAt: now, status: 'off' })
        .where(and(eq(speakers.roomId, room.id), eq(speakers.userId, userId), isNull(speakers.closedAt)));
      if (live.length)
        await ctx.services.rooms.publish(room.id, [{ type: 'user.notice', userId, kind: 'speaker_moved', message: 'Your speaker moved to another tab.' }]);
    }
    const [row] = await ctx.db
      .insert(speakers)
      .values({ id: newId(), userId, roomId: room.id, kind: body.kind, spotifyDeviceId: body.spotifyDeviceId ?? null, status: 'starting', createdAt: now })
      .returning();
    ctx.services.analytics.track('speaker_started', { userId, roomId: room.id, props: { kind: body.kind } });
    return { id: row!.id, roomId: room.id, kind: body.kind, status: 'starting' as const, spotifyDeviceId: row!.spotifyDeviceId, lastHeartbeatAt: null };
  },
  'speakers.heartbeat': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, body } = c;
    const sp = await ctx.db.query.speakers.findFirst({ where: and(eq(speakers.id, c.params.id), eq(speakers.userId, userId)) });
    if (!sp) throw new SpinroomError('not_found', 'Speaker not found');
    const now = ctx.clock.now();
    if (sp.closedAt) return { ok: true as const, serverNow: now, superseded: true };
    const audible = body.status === 'live' && body.audible;
    await ctx.db
      .update(speakers)
      .set({
        status: body.status,
        lastHeartbeatAt: now,
        ...(audible ? { lastAudibleAt: now } : {}),
        ...(body.spotifyDeviceId !== undefined ? { spotifyDeviceId: body.spotifyDeviceId } : {}),
      })
      .where(eq(speakers.id, sp.id));
    const m = await memberRow(ctx, sp.roomId, userId);
    await ctx.services.rooms.exec(sp.roomId, { type: 'speakerHeartbeat', userId, live: body.status === 'live', audible, role: m?.role ?? 'member' });
    await ctx.db
      .update(roomMembers)
      .set({ lastSeenAt: now })
      .where(and(eq(roomMembers.roomId, sp.roomId), eq(roomMembers.userId, userId)));
    if (typeof body.driftMs === 'number')
      ctx.services.analytics.track('drift_sample', { userId, roomId: sp.roomId, props: { driftMs: Math.round(body.driftMs), spinId: body.spinId } });
    if (typeof body.joinToAudioMs === 'number')
      ctx.services.analytics.track('join_to_audio', { userId, roomId: sp.roomId, props: { ms: Math.round(body.joinToAudioMs) } });
    return { ok: true as const, serverNow: now, superseded: false };
  },
  'speakers.close': async (c) => {
    const { userId } = requireUser(c);
    const { ctx } = c;
    const sp = await ctx.db.query.speakers.findFirst({ where: and(eq(speakers.id, c.params.id), eq(speakers.userId, userId)) });
    if (!sp) throw new SpinroomError('not_found', 'Speaker not found');
    if (!sp.closedAt) {
      await ctx.db.update(speakers).set({ closedAt: ctx.clock.now(), status: 'off' }).where(eq(speakers.id, sp.id));
      await ctx.services.rooms.exec(sp.roomId, { type: 'speakerHeartbeat', userId, live: false, audible: false });
    }
    return { ok: true as const };
  },
};

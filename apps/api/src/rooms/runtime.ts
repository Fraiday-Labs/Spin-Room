import { channels, SpinroomError, TIMING, type RoomEvent, type RoomEventBody, type RoomSettings, type RoomSnapshot } from '@spinroom/contracts';
import { apply, createRoomState, spinEndsAt, type Command, type Effect, type RoomState } from '@spinroom/room-engine';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import {
  avatarReports,
  boothSlots,
  chatMessages,
  crateItems,
  deletionRequests,
  djQueue,
  invites,
  roomMembers,
  rooms,
  slackLinks,
  speakers,
  spins,
  users,
  votes,
} from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { RoomHooks } from '../services/index.js';
import { roomSettings, type RoomRow } from './access.js';
import { RoomLocks } from './lock.js';
import { createSetService, type SetService } from './sets.js';
import { buildSnapshot, membersView, summarize, type RoomLiveSummary } from './snapshot.js';

const ACTIVE = 'rooms:active';
const TICK_MS = 5000;
const stateKey = (id: string) => `room:${id}:state`;
const seqKey = (id: string) => `room:${id}:seq`;
const summaryKey = (id: string) => `room:${id}:summary`;

export interface ExecResult {
  state: RoomState;
  events: RoomEvent[];
}

/**
 * Hosts the pure room engine: loads state (Redis, rebuilt from Postgres when missing),
 * applies commands under the per-room lock, performs effects, persists, and publishes
 * events with a monotonically increasing per-room `seq`.
 */
export class RoomRuntime implements RoomHooks {
  readonly locks: RoomLocks;
  readonly sets: SetService;
  private timers = new Map<string, { spinId: string; handle: ReturnType<typeof setTimeout> }>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private housekeeping: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly ctx: AppContext) {
    this.locks = new RoomLocks(ctx.redis);
    this.sets = createSetService(ctx);
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    this.stopped = false;
    if (!this.ctx.cfg.RUN_ROOM_ENGINE) return;
    // Reschedule spin timers from startedAtServerMs after a restart (reliability NFR).
    for (const id of await this.ctx.redis.smembers(ACTIVE)) {
      const s = await this.load(id).catch(() => null);
      if (s?.current) this.schedule(id, spinEndsAt(s.current), s.current.id);
    }
    if (this.ctx.cfg.NODE_ENV !== 'test') {
      this.ticker = setInterval(() => void this.tickAll().catch((e) => this.ctx.log.error({ err: e }, 'tick failed')), TICK_MS);
      this.housekeeping = setInterval(() => void this.cleanup().catch((e) => this.ctx.log.error({ err: e }, 'cleanup failed')), 3600_000);
    }
  }

  async stop() {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.housekeeping) clearInterval(this.housekeeping);
    for (const t of this.timers.values()) clearTimeout(t.handle);
    this.timers.clear();
  }

  /** Tick every active room once (one instance per room per interval). */
  async tickAll() {
    for (const id of await this.ctx.redis.smembers(ACTIVE)) {
      if (!(await this.ctx.redis.set(`room:${id}:tick`, '1', 'PX', TICK_MS - 500, 'NX'))) continue;
      await this.exec(id, { type: 'tick' }).catch((e) => this.ctx.log.warn({ err: e, roomId: id }, 'room tick failed'));
    }
  }

  /** Hourly: chat retention (30 days), history cap (200 spins), account deletion purge. */
  async cleanup() {
    const now = this.ctx.clock.now();
    await this.ctx.db.delete(chatMessages).where(lt(chatMessages.createdAt, now - TIMING.chatRetentionMs));
    const pending = await this.ctx.db.select().from(deletionRequests).where(isNull(deletionRequests.completedAt));
    for (const d of pending) {
      await this.ctx.db.delete(votes).where(eq(votes.userId, d.userId));
      await this.ctx.db.delete(chatMessages).where(eq(chatMessages.userId, d.userId));
      await this.ctx.db.update(deletionRequests).set({ completedAt: now }).where(eq(deletionRequests.userId, d.userId));
    }
  }

  // ---------------------------------------------------------------- state

  private async room(roomId: string): Promise<RoomRow> {
    const r = await this.ctx.db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
    if (!r) throw new Error(`room ${roomId} missing`);
    return r;
  }

  async load(roomId: string): Promise<RoomState> {
    const raw = await this.ctx.redis.get(stateKey(roomId));
    if (raw) return JSON.parse(raw) as RoomState;
    return this.rebuild(await this.room(roomId));
  }

  /** Rebuild live state from Postgres (Redis lost or first use). */
  private async rebuild(room: RoomRow): Promise<RoomState> {
    // A closed room has no live state; never resurrect it (stray timers, late commands).
    if (room.closedAt) throw new SpinroomError('room_closed', 'This room was closed by its owner');
    const now = this.ctx.clock.now();
    const settings = roomSettings(room);
    const s = createRoomState(room.id, settings, now);
    const slots = await this.ctx.db.select().from(boothSlots).where(eq(boothSlots.roomId, room.id));
    for (const b of slots)
      if (b.slot < s.booth.length) s.booth[b.slot] = { userId: b.userId, spinsThisTurn: b.spinsThisTurn, consecutiveSkips: b.consecutiveSkips };
    const q = await this.ctx.db.select().from(djQueue).where(eq(djQueue.roomId, room.id)).orderBy(asc(djQueue.position));
    s.queue = q.map((x) => ({ userId: x.userId, joinedAt: x.joinedAt, cooldownUntil: x.cooldownUntil }));
    for (const x of q) if (x.cooldownUntil && x.cooldownUntil > now) s.cooldowns[x.userId] = x.cooldownUntil;
    const open = await this.ctx.db.query.spins.findFirst({ where: and(eq(spins.roomId, room.id), isNull(spins.endedAt)), orderBy: desc(spins.startedAt) });
    if (open) {
      const slot = s.booth.findIndex((b) => b.userId === open.djUserId);
      const vs = await this.ctx.db.select().from(votes).where(eq(votes.spinId, open.id));
      s.current = {
        id: open.id,
        djUserId: open.djUserId,
        slot,
        track: {
          uri: open.trackUri,
          title: open.title,
          artists: open.artists,
          album: open.album,
          artUrl: open.artUrl,
          durationMs: open.durationMs,
          explicit: open.explicit,
          playable: true,
        },
        startedAtServerMs: open.startedAt,
        durationMs: open.durationMs,
        votes: Object.fromEntries(vs.map((v) => [v.userId, { value: v.value, surface: v.surface }])),
      };
      s.activeSlot = slot >= 0 ? slot : null;
      s.status = 'playing';
      if (slot < 0) s.current = null;
    }
    const recent = await this.ctx.db
      .select({ uri: spins.trackUri })
      .from(spins)
      .where(eq(spins.roomId, room.id))
      .orderBy(desc(spins.startedAt))
      .limit(TIMING.historyLimit);
    s.recent = recent.map((r) => r.uri).reverse();
    // The last finished song, for the DJ's Back button.
    const last = await this.ctx.db.query.spins.findFirst({ where: and(eq(spins.roomId, room.id), isNotNull(spins.endedAt)), orderBy: desc(spins.endedAt) });
    if (last)
      s.previous = {
        track: {
          uri: last.trackUri,
          title: last.title,
          artists: last.artists,
          album: last.album,
          artUrl: last.artUrl,
          durationMs: last.durationMs,
          explicit: last.explicit,
          playable: true,
        },
      };
    for (const uid of new Set([...s.booth.map((b) => b.userId).filter((x): x is string => !!x), ...s.queue.map((x) => x.userId)])) {
      s.sets[uid] = await this.sets.preview(room.id, uid);
    }
    // Members re-establish presence by reconnecting; keep booth members around for the drop window.
    for (const b of s.booth) {
      if (b.userId && !s.members[b.userId]) {
        s.members[b.userId] = {
          userId: b.userId,
          role: 'member',
          sockets: 0,
          remoteUntil: now + settings.djPresenceDropMs,
          speakerAt: null,
          lastAudioAt: null,
          absentSince: null,
          presence: 'remote',
          eligible: false,
        };
      }
    }
    return s;
  }

  // ---------------------------------------------------------------- exec

  /** Apply commands under the room lock; returns the new state and the published events. */
  async exec(roomId: string, cmds: Command | Command[], extraEvents: (s: RoomState) => RoomEventBody[] = () => []): Promise<ExecResult> {
    const list = Array.isArray(cmds) ? cmds : [cmds];
    return this.locks.with(roomId, async () => {
      const before = await this.load(roomId);
      let state = before;
      const bodies: RoomEventBody[] = [];
      const queue = [...list];
      const effects: Effect[] = [];
      let guard = 0;
      while (queue.length) {
        if (++guard > 200) throw new Error('command loop');
        const cmd = queue.shift()!;
        const r = apply(state, cmd, { now: this.ctx.clock.now(), newId });
        state = r.state;
        bodies.push(...r.events);
        for (const ef of r.effects) {
          effects.push(ef);
          const follow = await this.effect(roomId, ef);
          if (follow) queue.push(follow);
        }
      }
      bodies.push(...extraEvents(state));
      await this.save(roomId, before, state);
      const events = await this.publishLocked(roomId, await this.enrich(roomId, before, state, bodies));
      return { state, events };
    });
  }

  /** Perform one engine effect; may return a follow-up command. */
  private async effect(roomId: string, ef: Effect): Promise<Command | null> {
    const db = this.ctx.db;
    switch (ef.type) {
      case 'schedule':
        this.schedule(roomId, ef.at, ef.spinId);
        return null;
      case 'spinStarted': {
        const t = ef.spin.track;
        await db.insert(spins).values({
          id: ef.spin.id,
          roomId,
          djUserId: ef.spin.djUserId,
          trackUri: t.uri,
          title: t.title,
          artists: t.artists,
          album: t.album,
          artUrl: t.artUrl,
          explicit: t.explicit,
          durationMs: t.durationMs,
          startedAt: ef.spin.startedAtServerMs,
        });
        this.ctx.services.analytics.track('dj_turn_taken', { userId: ef.spin.djUserId, roomId });
        return null;
      }
      case 'spinShifted':
        // Keep Postgres in step so a rebuild from it (Redis lost) still knows where the track is.
        await db.update(spins).set({ startedAt: ef.startedAtServerMs }).where(eq(spins.id, ef.spinId));
        return null;
      case 'spinEnded':
        await db
          .update(spins)
          .set({ endedAt: ef.endedAt, endReason: ef.reason, hypeCount: ef.hype, skipCount: ef.skip, eligibleVoters: ef.eligibleVoters })
          .where(eq(spins.id, ef.spinId));
        if (this.timers.get(roomId)?.spinId === ef.spinId) this.clearTimer(roomId);
        await this.trimHistory(roomId);
        return null;
      case 'vote':
        if (ef.value === null) await db.delete(votes).where(and(eq(votes.spinId, ef.spinId), eq(votes.userId, ef.userId)));
        else
          await db
            .insert(votes)
            .values({ spinId: ef.spinId, userId: ef.userId, value: ef.value, surface: ef.surface, updatedAt: this.ctx.clock.now() })
            .onConflictDoUpdate({ target: [votes.spinId, votes.userId], set: { value: ef.value, surface: ef.surface, updatedAt: this.ctx.clock.now() } });
        if (ef.value) this.ctx.services.analytics.track('vote_cast', { userId: ef.userId, roomId, props: { surface: ef.surface, value: ef.value } });
        return null;
      case 'advanceSet':
        await this.sets.advance(roomId, ef.userId, ef.by);
        return { type: 'setUpdated', userId: ef.userId, preview: await this.sets.preview(roomId, ef.userId) };
      case 'refreshSet':
        // Spotify reads happen outside the lock; the fresh preview arrives as its own command.
        void this.refreshSet(roomId, ef.userId);
        return null;
      case 'awardPoints':
        await db
          .update(users)
          .set({ points: sql`${users.points} + ${ef.points}` })
          .where(eq(users.id, ef.userId));
        return null;
    }
  }

  async refreshSet(roomId: string, userId: string) {
    try {
      await this.sets.refresh(roomId, userId);
      await this.exec(roomId, { type: 'setUpdated', userId, preview: await this.sets.preview(roomId, userId) });
    } catch (e) {
      this.ctx.log.warn({ err: e, roomId, userId }, 'set refresh failed');
    }
  }

  private async trimHistory(roomId: string) {
    const old = await this.ctx.db
      .select({ id: spins.id })
      .from(spins)
      .where(eq(spins.roomId, roomId))
      .orderBy(desc(spins.startedAt))
      .offset(TIMING.historyLimit)
      .limit(500);
    if (old.length) {
      const ids = old.map((o) => o.id);
      await this.ctx.db.delete(votes).where(inArray(votes.spinId, ids));
      await this.ctx.db.delete(spins).where(inArray(spins.id, ids));
    }
  }

  private async save(roomId: string, before: RoomState, after: RoomState) {
    const r = this.ctx.redis;
    await r.set(stateKey(roomId), JSON.stringify(after));
    const anyone = Object.keys(after.members).length > 0 || after.current !== null;
    if (anyone) await r.sadd(ACTIVE, roomId);
    else await r.srem(ACTIVE, roomId);

    // Mirror booth and queue to Postgres for durability.
    if (JSON.stringify(before.booth) !== JSON.stringify(after.booth)) {
      await this.ctx.db.delete(boothSlots).where(eq(boothSlots.roomId, roomId));
      await this.ctx.db
        .insert(boothSlots)
        .values(after.booth.map((b, slot) => ({ roomId, slot, userId: b.userId, consecutiveSkips: b.consecutiveSkips, spinsThisTurn: b.spinsThisTurn })));
    }
    if (JSON.stringify(before.queue) !== JSON.stringify(after.queue)) {
      await this.ctx.db.delete(djQueue).where(eq(djQueue.roomId, roomId));
      if (after.queue.length) {
        await this.ctx.db
          .insert(djQueue)
          .values(after.queue.map((q, i) => ({ roomId, userId: q.userId, position: i, joinedAt: q.joinedAt, cooldownUntil: q.cooldownUntil })));
      }
    }
    const dj = after.current ? await this.ctx.services.users.get(after.current.djUserId) : null;
    const sum = summarize(after, this.ctx.clock.now(), dj?.displayName ?? null);
    await r.set(summaryKey(roomId), JSON.stringify(sum), 'EX', 86_400);
  }

  /** Attach member profiles to presence events for members who just appeared. */
  private async enrich(roomId: string, before: RoomState, after: RoomState, bodies: RoomEventBody[]): Promise<RoomEventBody[]> {
    const fresh = bodies
      .filter((b): b is Extract<RoomEventBody, { type: 'presence.changed' }> => b.type === 'presence.changed' && !b.left && !before.members[b.userId])
      .map((b) => b.userId);
    if (!fresh.length) return bodies;
    const views = new Map((await membersView(this.ctx, roomId, after, fresh)).map((m) => [m.user.id, m]));
    return bodies.map((b) => (b.type === 'presence.changed' && views.has(b.userId) && !b.left ? { ...b, member: views.get(b.userId)! } : b));
  }

  /** Stamp seq/roomId/at and publish (caller holds the lock). */
  private async publishLocked(roomId: string, bodies: RoomEventBody[]): Promise<RoomEvent[]> {
    if (!bodies.length) return [];
    const last = await this.ctx.redis.incrby(seqKey(roomId), bodies.length);
    const first = last - bodies.length + 1;
    const at = this.ctx.clock.now();
    const events = bodies.map((b, i) => ({ ...b, seq: first + i, roomId, at }) as RoomEvent);
    const p = this.ctx.redis.pipeline();
    for (const e of events) p.publish(channels.room(roomId), JSON.stringify(e));
    await p.exec();
    return events;
  }

  /**
   * Close or delete: end the current spin, tell every client (live sockets close after this
   * event) and drop the live state. Booth and DJ queue are cleared, so a reopened room starts fresh.
   */
  async shutdown(roomId: string, reason: 'closed' | 'deleted') {
    await this.locks.with(roomId, async () => {
      const raw = await this.ctx.redis.get(stateKey(roomId));
      const state = raw ? (JSON.parse(raw) as RoomState) : null;
      if (state?.current)
        await this.ctx.db
          .update(spins)
          .set({ endedAt: this.ctx.clock.now(), endReason: 'room_closed' })
          .where(and(eq(spins.id, state.current.id), isNull(spins.endedAt)));
      this.clearTimer(roomId);
      await this.publishLocked(roomId, [{ type: 'room.closed', reason }]);
      await this.ctx.redis.del(stateKey(roomId), summaryKey(roomId), `room:${roomId}:tick`);
      await this.ctx.redis.srem(ACTIVE, roomId);
      await this.ctx.db.delete(boothSlots).where(eq(boothSlots.roomId, roomId));
      await this.ctx.db.delete(djQueue).where(eq(djQueue.roomId, roomId));
    });
  }

  /** Delete a (shut down) room and everything that belongs to it. Spotify playlists are untouched. */
  async purge(roomId: string) {
    await this.ctx.db.transaction(async (tx) => {
      const spinIds = (await tx.select({ id: spins.id }).from(spins).where(eq(spins.roomId, roomId))).map((r) => r.id);
      if (spinIds.length) await tx.delete(votes).where(inArray(votes.spinId, spinIds));
      await tx.delete(spins).where(eq(spins.roomId, roomId));
      await tx.delete(chatMessages).where(eq(chatMessages.roomId, roomId));
      await tx.delete(crateItems).where(eq(crateItems.roomId, roomId));
      await tx.delete(djQueue).where(eq(djQueue.roomId, roomId));
      await tx.delete(boothSlots).where(eq(boothSlots.roomId, roomId));
      await tx.delete(speakers).where(eq(speakers.roomId, roomId));
      await tx.delete(invites).where(eq(invites.roomId, roomId));
      await tx.delete(slackLinks).where(eq(slackLinks.roomId, roomId));
      await tx.update(avatarReports).set({ roomId: null }).where(eq(avatarReports.roomId, roomId));
      await tx.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await tx.delete(rooms).where(eq(rooms.id, roomId));
    });
    await this.ctx.redis.del(seqKey(roomId));
  }

  /** Publish events that don't go through the engine (chat, settings, avatars). */
  async publish(roomId: string, bodies: RoomEventBody[]): Promise<RoomEvent[]> {
    return this.locks.with(roomId, () => this.publishLocked(roomId, bodies));
  }

  async snapshot(room: RoomRow, viewerId: string | null): Promise<RoomSnapshot> {
    return this.locks.with(room.id, async () => {
      const state = await this.load(room.id);
      const seq = Number((await this.ctx.redis.get(seqKey(room.id))) ?? 0);
      return buildSnapshot(this.ctx, room, state, seq, viewerId);
    });
  }

  async summaries(roomIds: string[]): Promise<Map<string, RoomLiveSummary>> {
    if (!roomIds.length) return new Map();
    const raw = await this.ctx.redis.mget(roomIds.map(summaryKey));
    return new Map(
      roomIds.map((id, i) => [id, raw[i] ? (JSON.parse(raw[i]!) as RoomLiveSummary) : { listeners: 0, liveSpeakers: 0, status: 'idle', nowPlaying: null }]),
    );
  }

  // ---------------------------------------------------------------- timers

  private schedule(roomId: string, at: number, spinId: string) {
    if (this.stopped || !this.ctx.cfg.RUN_ROOM_ENGINE) return;
    this.clearTimer(roomId);
    // A paused spin has no end yet; resuming schedules it again.
    if (!Number.isFinite(at)) return;
    const handle = setTimeout(
      () => {
        this.timers.delete(roomId);
        void this.exec(roomId, { type: 'timer', spinId }).catch((e) => this.ctx.log.error({ err: e, roomId, spinId }, 'spin timer failed'));
      },
      Math.max(0, at - this.ctx.clock.now()),
    );
    handle.unref?.();
    this.timers.set(roomId, { spinId, handle });
  }

  private clearTimer(roomId: string) {
    const t = this.timers.get(roomId);
    if (t) clearTimeout(t.handle);
    this.timers.delete(roomId);
  }

  // ---------------------------------------------------------------- hooks used by other services

  async settingsChanged(room: RoomRow, settings: RoomSettings) {
    await this.exec(room.id, { type: 'settings', settings }, () => [
      { type: 'room.settings_changed', settings, name: room.name, description: room.description },
    ]);
  }

  /** Re-announce a member whose profile or avatar changed (presence.changed carries thumb + sheet). */
  async onProfileChanged(userId: string) {
    const memberships = await this.ctx.db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, userId));
    for (const { roomId } of memberships) {
      if (!(await this.ctx.redis.sismember(ACTIVE, roomId))) continue;
      const state = await this.load(roomId);
      if (!state.members[userId]) continue;
      const [view] = await membersView(this.ctx, roomId, state, [userId]);
      if (view)
        await this.publish(roomId, [
          { type: 'presence.changed', userId, state: view.presence, eligible: view.eligible, member: view, avatar: view.user.avatar },
        ]);
    }
  }

  async onAccountDeleted(userId: string) {
    const memberships = await this.ctx.db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(eq(roomMembers.userId, userId));
    for (const { roomId } of memberships) {
      await this.exec(roomId, { type: 'leave', userId }).catch(() => {});
    }
    await this.ctx.db.delete(crateItems).where(eq(crateItems.userId, userId));
    await this.ctx.db.delete(roomMembers).where(and(eq(roomMembers.userId, userId), notInArray(roomMembers.role, ['owner'])));
  }
}

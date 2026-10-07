import { TIMING, type ChatMessage, type Member, type RoomSnapshot, type RoomSummary, type SpeakerStatus } from '@spinroom/contracts';
import { computeUpNext, isEligible, presenceOf, tally, type RoomState } from '@spinroom/room-engine';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { chatMessages, roomMembers, speakers } from '../db/schema.js';
import { toRoom, type RoomRow } from './access.js';

export function chatView(r: typeof chatMessages.$inferSelect): ChatMessage {
  return { id: r.id, roomId: r.roomId, userId: r.userId, text: r.text, reactions: r.reactions ?? {}, createdAt: r.createdAt };
}

/** Member records for the given users as everyone in the room sees them. */
export async function membersView(ctx: AppContext, roomId: string, state: RoomState, userIds: string[]): Promise<Member[]> {
  if (!userIds.length) return [];
  const [users, rows] = await Promise.all([
    ctx.services.users.getMany(userIds),
    ctx.db.select().from(roomMembers).where(and(eq(roomMembers.roomId, roomId), inArray(roomMembers.userId, userIds))),
  ]);
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const now = ctx.clock.now();
  const out: Member[] = [];
  for (const id of userIds) {
    const u = users.get(id);
    if (!u) continue;
    const row = byUser.get(id);
    const m = state.members[id];
    out.push({
      user: await ctx.services.users.toPublic(u, { hidden: row?.avatarHidden ?? false }),
      role: row?.role ?? m?.role ?? 'member',
      presence: m ? presenceOf(m, now) : 'away',
      eligible: m ? isEligible(m, state.settings, now) : false,
      avatarHidden: row?.avatarHidden ?? false,
      muted: row?.muted ?? false,
    });
  }
  return out;
}

/** Users the room should render: present members plus everyone on the booth or in the queue. */
export function visibleUserIds(state: RoomState, now: number): string[] {
  const ids = new Set<string>();
  for (const m of Object.values(state.members)) if (presenceOf(m, now) !== 'away') ids.add(m.userId);
  for (const b of state.booth) if (b.userId) ids.add(b.userId);
  for (const q of state.queue) ids.add(q.userId);
  return [...ids];
}

export async function speakerStatusFor(ctx: AppContext, roomId: string, userId: string): Promise<SpeakerStatus> {
  const row = await ctx.db.query.speakers.findFirst({
    where: and(eq(speakers.roomId, roomId), eq(speakers.userId, userId), isNull(speakers.closedAt)),
    orderBy: desc(speakers.createdAt),
  });
  if (!row || !row.lastHeartbeatAt || ctx.clock.now() - row.lastHeartbeatAt > TIMING.speakerLiveMs) return row?.status === 'starting' ? 'starting' : 'off';
  return row.status as SpeakerStatus;
}

export async function buildSnapshot(ctx: AppContext, room: RoomRow, state: RoomState, seq: number, viewerId: string | null): Promise<RoomSnapshot> {
  const now = ctx.clock.now();
  const [members, chat] = await Promise.all([
    membersView(ctx, room.id, state, visibleUserIds(state, now)),
    ctx.db.select().from(chatMessages).where(eq(chatMessages.roomId, room.id)).orderBy(desc(chatMessages.createdAt)).limit(50),
  ]);
  const t = tally(state, now);
  const cur = state.current;
  let me: RoomSnapshot['me'] = null;
  if (viewerId) {
    const row = await ctx.db.query.roomMembers.findFirst({ where: and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, viewerId)) });
    const slot = state.booth.findIndex((b) => b.userId === viewerId);
    const cd = state.cooldowns[viewerId] ?? state.queue.find((q) => q.userId === viewerId)?.cooldownUntil ?? null;
    me = {
      role: row?.role ?? null,
      vote: cur?.votes[viewerId]?.value ?? null,
      speakerStatus: await speakerStatusFor(ctx, room.id, viewerId),
      inQueue: state.queue.some((q) => q.userId === viewerId),
      boothSlot: slot >= 0 ? slot : null,
      cooldownUntil: cd && cd > now ? cd : null,
    };
  }
  return {
    seq,
    serverNow: now,
    room: toRoom(room),
    status: state.status,
    members,
    booth: state.booth.map((b, slot) => ({ slot, userId: b.userId, spinsThisTurn: b.spinsThisTurn, consecutiveSkips: b.consecutiveSkips })),
    activeSlot: state.activeSlot,
    queue: state.queue.map((q) => ({ ...q })),
    currentSpin: cur
      ? { id: cur.id, djUserId: cur.djUserId, track: cur.track, startedAtServerMs: cur.startedAtServerMs, durationMs: cur.durationMs, endedAt: null, endReason: null }
      : null,
    tally: { hype: t.hype, skip: t.skip, eligibleVoters: t.eligibleVoters },
    upNext: computeUpNext(state),
    recentChat: chat.reverse().map(chatView),
    me,
  };
}

export interface RoomLiveSummary {
  listeners: number;
  liveSpeakers: number;
  status: RoomSummary['status'];
  nowPlaying: RoomSummary['nowPlaying'];
}

export function summarize(state: RoomState, now: number, djName: string | null): RoomLiveSummary {
  const ms = Object.values(state.members);
  return {
    listeners: ms.filter((m) => presenceOf(m, now) !== 'away').length,
    liveSpeakers: ms.filter((m) => presenceOf(m, now) === 'speaker').length,
    status: state.status,
    nowPlaying: state.current ? { title: state.current.track.title, artists: state.current.track.artists, djName: djName ?? 'DJ' } : null,
  };
}

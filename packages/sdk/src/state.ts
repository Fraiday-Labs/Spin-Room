import type { RoomEvent, RoomSnapshot } from '@spinroom/contracts';

const CHAT_KEEP = 100;

/**
 * Apply one live event to a snapshot. Pure; shared by the web app, MCP resource and Slack card.
 * `myUserId` keeps the caller-specific `me` block current.
 */
export function applyEvent(s: RoomSnapshot, ev: RoomEvent, myUserId: string | null = null): RoomSnapshot {
  if (ev.type === 'room.snapshot') return ev.snapshot;
  const next: RoomSnapshot = { ...s, seq: ev.seq };
  switch (ev.type) {
    case 'presence.changed': {
      if (ev.left) {
        next.members = s.members.filter((m) => m.user.id !== ev.userId);
        break;
      }
      const i = s.members.findIndex((m) => m.user.id === ev.userId);
      if (i < 0) {
        if (ev.member) next.members = [...s.members, ev.member];
        break;
      }
      const m = s.members[i]!;
      const updated = ev.member ?? { ...m, presence: ev.state, eligible: ev.eligible, user: ev.avatar ? { ...m.user, avatar: ev.avatar } : m.user };
      next.members = s.members.map((x, j) => (j === i ? updated : x));
      break;
    }
    case 'booth.changed':
      next.booth = ev.booth;
      next.activeSlot = ev.activeSlot;
      if (next.me) next.me = { ...next.me, boothSlot: ev.booth.find((b) => b.userId && myUserId === b.userId)?.slot ?? null };
      break;
    case 'dj_queue.changed':
      next.queue = ev.queue;
      if (next.me) next.me = { ...next.me, inQueue: ev.queue.some((q) => q.userId === myUserId) };
      break;
    case 'spin.started':
      next.currentSpin = ev.spin;
      next.upNext = ev.upNext;
      next.tally = { hype: 0, skip: 0, eligibleVoters: s.tally.eligibleVoters };
      next.status = 'playing';
      if (next.me) next.me = { ...next.me, vote: null };
      break;
    case 'spin.ended':
      if (s.currentSpin?.id === ev.spinId) next.currentSpin = null;
      next.tally = { hype: ev.hype, skip: ev.skip, eligibleVoters: ev.eligibleVoters };
      break;
    case 'spin.playback':
      if (s.currentSpin?.id === ev.spinId)
        next.currentSpin = { ...s.currentSpin, startedAtServerMs: ev.startedAtServerMs, pausedAtServerMs: ev.pausedAtServerMs };
      break;
    case 'votes.changed':
      if (s.currentSpin?.id === ev.spinId) next.tally = ev.tally;
      break;
    case 'chat.message':
      next.recentChat = [...s.recentChat, ev.message].slice(-CHAT_KEEP);
      break;
    case 'chat.reaction':
      next.recentChat = s.recentChat.map((m) => (m.id === ev.messageId ? { ...m, reactions: ev.reactions } : m));
      break;
    case 'room.settings_changed':
      next.room = { ...s.room, settings: ev.settings, name: ev.name, description: ev.description };
      break;
    case 'room.closed':
      next.status = 'idle';
      next.currentSpin = null;
      break;
    case 'room.status_changed':
      next.status = ev.status;
      if (ev.status === 'idle') next.currentSpin = null;
      break;
    case 'up_next.changed':
      next.upNext = ev.upNext;
      break;
    case 'dj.bounced':
      if (next.me && ev.userId === myUserId) next.me = { ...next.me, cooldownUntil: ev.cooldownUntil };
      break;
    case 'user.notice':
      break;
  }
  return next;
}

/** Expected playback position for a spin given a server clock offset (sync step 3). */
export function expectedPositionMs(startedAtServerMs: number, serverNow: number): number {
  return serverNow - startedAtServerMs;
}

export function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

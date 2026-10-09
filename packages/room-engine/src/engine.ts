import {
  SpinroomError,
  TIMING,
  type EndReason,
  type PresenceState,
  type RoomEventBody,
  type RoomSettings,
  type Tally,
  type Track,
  type UpNextItem,
} from '@spinroom/contracts';
import type { ApplyResult, BoothSlotState, Command, Effect, EngineSpin, Env, MemberState, RoomState } from './types.js';

/** Members away longer than this are dropped from live state (they stay room members in the DB). */
export const AWAY_PRUNE_MS = 10 * 60_000;
/** How many upcoming tracks the runtime keeps in each set preview. */
export const SET_PREVIEW_SIZE = 10;

export function createRoomState(roomId: string, settings: RoomSettings, now: number): RoomState {
  return {
    roomId,
    settings,
    status: 'idle',
    paused: false,
    members: {},
    booth: Array.from({ length: settings.boothSlots }, () => emptySlot()),
    activeSlot: null,
    queue: [],
    cooldowns: {},
    current: null,
    sets: {},
    recent: [],
    lastSpeakerLiveAt: now,
    upNextNotified: null,
  };
}

const emptySlot = (): BoothSlotState => ({ userId: null, spinsThisTurn: 0, consecutiveSkips: 0 });

// ------------------------------------------------------------------ presence (FR-P2, FR-V2, FR-L2)

export function speakerLive(m: MemberState, now: number): boolean {
  return m.speakerAt !== null && now - m.speakerAt <= TIMING.speakerLiveMs;
}

export function isPresent(m: MemberState, now: number): boolean {
  return m.sockets > 0 || m.remoteUntil > now || speakerLive(m, now);
}

export function presenceOf(m: MemberState, now: number): PresenceState {
  if (speakerLive(m, now)) return 'speaker';
  return isPresent(m, now) ? 'remote' : 'away';
}

/** FR-V2: a live speaker, or heard audio in the last `recentListenMs`. Must also be present. */
export function isEligible(m: MemberState, s: RoomSettings, now: number): boolean {
  if (!isPresent(m, now)) return false;
  return speakerLive(m, now) || (m.lastAudioAt !== null && now - m.lastAudioAt <= s.recentListenMs);
}

function newMember(userId: string, role: MemberState['role']): MemberState {
  return { userId, role, sockets: 0, remoteUntil: 0, speakerAt: null, lastAudioAt: null, absentSince: null, presence: 'away', eligible: false };
}

// ------------------------------------------------------------------ transaction

class Tx {
  readonly events: RoomEventBody[] = [];
  readonly effects: Effect[] = [];
  boothDirty = false;
  queueDirty = false;
  /** A spin ended with a fade but the next one was not started yet. */
  fadePending = false;
  upNextDirty = false;
  constructor(
    readonly s: RoomState,
    readonly env: Env,
  ) {}
  get now() {
    return this.env.now;
  }
  emit(e: RoomEventBody) {
    this.events.push(e);
  }
  effect(e: Effect) {
    this.effects.push(e);
  }
  notice(userId: string, kind: Extract<RoomEventBody, { type: 'user.notice' }>['kind'], message: string) {
    this.emit({ type: 'user.notice', userId, kind, message });
  }
}

// ------------------------------------------------------------------ apply

/**
 * Copy everything the engine mutates. Tracks and set previews are immutable once created
 * (previews are only ever replaced), so they are shared between states.
 */
export function cloneState(s: RoomState): RoomState {
  const members: RoomState['members'] = {};
  for (const [k, m] of Object.entries(s.members)) members[k] = { ...m };
  return {
    ...s,
    settings: { ...s.settings },
    members,
    booth: s.booth.map((b) => ({ ...b })),
    queue: s.queue.map((q) => ({ ...q })),
    cooldowns: { ...s.cooldowns },
    current: s.current ? { ...s.current, votes: { ...s.current.votes } } : null,
    sets: { ...s.sets },
    recent: [...s.recent],
  };
}

export function apply(state: RoomState, cmd: Command, env: Env): ApplyResult {
  const tx = new Tx(cloneState(state), env);
  const s = tx.s;
  switch (cmd.type) {
    case 'connect': {
      const m = ensureMember(tx, cmd.userId, cmd.role);
      m.sockets++;
      break;
    }
    case 'disconnect': {
      const m = s.members[cmd.userId];
      if (m) m.sockets = Math.max(0, m.sockets - 1);
      break;
    }
    case 'remoteAction': {
      const m = ensureMember(tx, cmd.userId, cmd.role);
      m.remoteUntil = Math.max(m.remoteUntil, tx.now + s.settings.remotePresenceMs);
      break;
    }
    case 'leave':
      removeMember(tx, cmd.userId, cmd.kicked ?? false);
      break;
    case 'roleChanged': {
      const m = s.members[cmd.userId];
      if (m) m.role = cmd.role;
      break;
    }
    case 'speakerHeartbeat': {
      // A live speaker makes its member present even without an open room socket.
      const m = s.members[cmd.userId] ?? (cmd.live && cmd.role ? ensureMember(tx, cmd.userId, cmd.role) : undefined);
      if (!m) break;
      m.speakerAt = cmd.live ? tx.now : null;
      if (cmd.audible) m.lastAudioAt = tx.now;
      if (cmd.live) {
        s.lastSpeakerLiveAt = tx.now;
        if (s.paused) resume(tx);
      }
      break;
    }
    case 'queueJoin':
      queueJoin(tx, cmd.userId);
      break;
    case 'queueLeave':
      queueLeave(tx, cmd.userId);
      break;
    case 'vote':
      vote(tx, cmd);
      break;
    case 'skip': {
      const cur = s.current;
      if (!cur) throw new SpinroomError('spin_not_current', 'Nothing is playing');
      if (cmd.by === 'dj' && cur.djUserId !== cmd.userId) throw new SpinroomError('forbidden', 'Only the DJ can skip their own spin');
      endSpin(tx, cmd.by === 'dj' ? 'dj_skip' : 'mod_skip');
      break;
    }
    case 'pause': {
      const cur = s.current;
      if (!cur) throw new SpinroomError('spin_not_current', 'Nothing is playing');
      if (cmd.by === 'dj' && cur.djUserId !== cmd.userId) throw new SpinroomError('forbidden', 'Only the DJ can pause their own spin');
      if (cmd.paused) pauseSpin(tx);
      else resumeSpin(tx);
      break;
    }
    case 'removeFromBooth':
      removeFromBooth(tx, cmd.userId, 'removed_from_booth', 'A moderator removed you from the booth.');
      break;
    case 'timer':
      if (s.current?.id === cmd.spinId && tx.now >= spinEndsAt(s.current) - 50) endSpin(tx, 'completed');
      break;
    case 'setUpdated':
      s.sets[cmd.userId] = cmd.preview;
      tx.upNextDirty = true;
      break;
    case 'settings':
      changeSettings(tx, cmd.settings);
      break;
    case 'tick':
      break;
  }
  sweep(tx);
  finish(tx, state);
  return { state: s, events: tx.events, effects: tx.effects };
}

/** When the server ends a spin; never, while it is paused. */
export function spinEndsAt(spin: Pick<EngineSpin, 'startedAtServerMs' | 'durationMs' | 'pausedAt'>): number {
  if (spin.pausedAt) return Number.POSITIVE_INFINITY;
  return spin.startedAtServerMs + spin.durationMs + TIMING.endGraceMs;
}

function pauseSpin(tx: Tx) {
  const cur = tx.s.current;
  if (!cur || cur.pausedAt) return;
  // Paused during a fade-in: hold at the very start.
  cur.pausedAt = Math.max(tx.now, cur.startedAtServerMs);
  tx.emit({ type: 'spin.playback', spinId: cur.id, startedAtServerMs: cur.startedAtServerMs, pausedAtServerMs: cur.pausedAt });
}

function resumeSpin(tx: Tx) {
  const cur = tx.s.current;
  if (!cur?.pausedAt) return;
  // Pick up where it stopped: the start moves later by the time spent paused.
  cur.startedAtServerMs += Math.max(0, tx.now - cur.pausedAt);
  cur.pausedAt = null;
  tx.effect({ type: 'spinShifted', spinId: cur.id, startedAtServerMs: cur.startedAtServerMs });
  tx.effect({ type: 'schedule', at: spinEndsAt(cur), spinId: cur.id });
  tx.emit({ type: 'spin.playback', spinId: cur.id, startedAtServerMs: cur.startedAtServerMs, pausedAtServerMs: null });
}

function ensureMember(tx: Tx, userId: string, role: MemberState['role']): MemberState {
  const s = tx.s;
  let m = s.members[userId];
  if (!m) {
    const present = Object.values(s.members).filter((x) => isPresent(x, tx.now)).length;
    if (present >= s.settings.maxPresent) throw new SpinroomError('room_full', `This room is full (${s.settings.maxPresent} people)`);
    m = newMember(userId, role);
    s.members[userId] = m;
  } else if (!isPresent(m, tx.now)) {
    const present = Object.values(s.members).filter((x) => isPresent(x, tx.now)).length;
    if (present >= s.settings.maxPresent) throw new SpinroomError('room_full', `This room is full (${s.settings.maxPresent} people)`);
  }
  m.role = role;
  return m;
}

function removeMember(tx: Tx, userId: string, kicked: boolean) {
  const s = tx.s;
  if (!s.members[userId]) return;
  removeFromBooth(tx, userId, null, '');
  if (s.queue.some((q) => q.userId === userId)) {
    s.queue = s.queue.filter((q) => q.userId !== userId);
    tx.queueDirty = true;
  }
  delete s.members[userId];
  delete s.sets[userId];
  if (kicked) tx.notice(userId, 'kicked', 'You were removed from the room by a moderator.');
  tx.emit({ type: 'presence.changed', userId, state: 'away', eligible: false, left: true });
}

// ------------------------------------------------------------------ DJ queue & booth (FR-D1–D5)

function onCooldown(s: RoomState, userId: string, now: number): number | null {
  const until = s.cooldowns[userId];
  return until !== undefined && until > now ? until : null;
}

function hasPlayable(s: RoomState, userId: string): boolean {
  const p = s.sets[userId];
  return Boolean(p && p.length > 0 && p.tracks.some((t) => trackAllowed(s, t).ok));
}

function queueJoin(tx: Tx, userId: string) {
  const s = tx.s;
  const m = s.members[userId];
  if (!m || !isPresent(m, tx.now)) throw new SpinroomError('not_present', 'Join the room first');
  if (s.booth.some((b) => b.userId === userId) || s.queue.some((q) => q.userId === userId)) {
    throw new SpinroomError('already_in_queue', 'You are already in the DJ queue or at the booth');
  }
  const cd = onCooldown(s, userId, tx.now);
  if (cd !== null) throw new SpinroomError('on_cooldown', 'You were bounced recently — try again soon', { cooldownUntil: cd });
  if (!hasPlayable(s, userId)) throw new SpinroomError('crate_empty', 'Add at least one playable track to your set first');
  s.queue.push({ userId, joinedAt: tx.now, cooldownUntil: null });
  tx.queueDirty = true;
}

function queueLeave(tx: Tx, userId: string) {
  const s = tx.s;
  if (s.queue.some((q) => q.userId === userId)) {
    s.queue = s.queue.filter((q) => q.userId !== userId);
    tx.queueDirty = true;
  }
  removeFromBooth(tx, userId, null, '');
}

/** Take a DJ off the booth; ends their spin if it is playing (end_reason dj_left). */
function removeFromBooth(tx: Tx, userId: string, kind: 'removed_from_booth' | 'crate_ran_out' | null, message: string) {
  const s = tx.s;
  const i = s.booth.findIndex((b) => b.userId === userId);
  if (i < 0) return;
  if (s.current?.djUserId === userId) endSpin(tx, 'dj_left', { refill: false });
  s.booth[i] = emptySlot();
  tx.boothDirty = true;
  if (kind) tx.notice(userId, kind, message);
}

/** FR-D2: first person in the queue (not on cooldown) takes each open slot. */
function fillBooth(tx: Tx) {
  const s = tx.s;
  for (let i = 0; i < s.booth.length; i++) {
    if (s.booth[i]!.userId) continue;
    const idx = s.queue.findIndex((q) => (q.cooldownUntil ?? 0) <= tx.now && hasPlayable(s, q.userId));
    if (idx < 0) break;
    const [entry] = s.queue.splice(idx, 1);
    s.booth[i] = { userId: entry!.userId, spinsThisTurn: 0, consecutiveSkips: 0 };
    tx.boothDirty = true;
    tx.queueDirty = true;
  }
}

/** Occupied slots in round-robin order after `after` (FR-D3). */
export function rotationOrder(booth: BoothSlotState[], after: number | null): number[] {
  const n = booth.length;
  const start = after === null ? 0 : after + 1;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (booth[i]!.userId) out.push(i);
  }
  return out;
}

// ------------------------------------------------------------------ track selection (FR-C3, FR-D7, FR-D8, FR-L6)

function trackAllowed(s: RoomState, t: Track): { ok: true } | { ok: false; why: 'unplayable' | 'too_long' | 'explicit' | 'repeat' } {
  if (!t.playable) return { ok: false, why: 'unplayable' };
  if (t.durationMs > s.settings.maxTrackMs) return { ok: false, why: 'too_long' };
  if (s.settings.blockExplicit && t.explicit) return { ok: false, why: 'explicit' };
  if (s.settings.noRepeatWindow && s.recent.slice(-s.settings.noRepeatWindow).includes(t.uri)) return { ok: false, why: 'repeat' };
  return { ok: true };
}

// ------------------------------------------------------------------ spins

function startNext(tx: Tx, afterFade: boolean) {
  const s = tx.s;
  if (s.current || s.paused) return;
  afterFade ||= tx.fadePending;
  tx.fadePending = false;
  fillBooth(tx);
  // Each DJ gets a chance; DJs with nothing playable step down (FR-L5).
  for (let guard = 0; guard < s.booth.length + s.queue.length + 1; guard++) {
    const order = rotationOrder(s.booth, s.activeSlot);
    if (order.length === 0) {
      setStatus(tx, 'idle');
      return;
    }
    const slot = order[0]!;
    const dj = s.booth[slot]!.userId!;
    const preview = s.sets[dj] ?? { tracks: [], length: 0 };
    let chosen: Track | null = null;
    let consumed = 0;
    for (const t of preview.tracks) {
      consumed++;
      const ok = trackAllowed(s, t);
      if (ok.ok) {
        chosen = t;
        break;
      }
      if (ok.why === 'unplayable') tx.notice(dj, 'track_skipped_unplayable', `Skipped “${t.title}” — it isn’t playable right now.`);
    }
    if (!chosen) {
      if (consumed > 0) tx.effect({ type: 'advanceSet', userId: dj, by: consumed });
      s.activeSlot = slot;
      s.booth[slot] = emptySlot();
      tx.boothDirty = true;
      tx.notice(dj, 'crate_ran_out', 'Your set has no playable tracks left, so you stepped down from the booth.');
      fillBooth(tx);
      continue;
    }
    const spin: EngineSpin = {
      id: tx.env.newId(),
      djUserId: dj,
      slot,
      track: chosen,
      startedAtServerMs: tx.now + (afterFade ? TIMING.fadeMs : 0),
      durationMs: chosen.durationMs,
      votes: {},
    };
    s.current = spin;
    s.activeSlot = slot;
    s.booth[slot]!.spinsThisTurn++;
    tx.boothDirty = true;
    s.recent.push(chosen.uri);
    if (s.recent.length > TIMING.historyLimit) s.recent.splice(0, s.recent.length - TIMING.historyLimit);
    // Consume locally so Up next stays right until the runtime sends a fresh preview.
    s.sets[dj] = { tracks: preview.tracks.slice(consumed), length: preview.length };
    tx.effect({ type: 'advanceSet', userId: dj, by: consumed });
    tx.effect({ type: 'spinStarted', spin: { ...spin, votes: {} } });
    tx.effect({ type: 'schedule', at: spinEndsAt(spin), spinId: spin.id });
    setStatus(tx, 'playing');
    const upNext = computeUpNext(s);
    tx.emit({
      type: 'spin.started',
      spin: {
        id: spin.id,
        djUserId: dj,
        track: chosen,
        startedAtServerMs: spin.startedAtServerMs,
        durationMs: spin.durationMs,
        endedAt: null,
        endReason: null,
      },
      upNext,
    });
    tx.upNextDirty = false;
    notifyUpNext(tx, upNext);
    return;
  }
}

/** FR-L4: tell the next DJ one spin ahead, and have the runtime re-read their set. */
function notifyUpNext(tx: Tx, upNext: UpNextItem[]) {
  const s = tx.s;
  const next = upNext[0]?.djUserId ?? null;
  if (!next || next === s.current?.djUserId) {
    s.upNextNotified = null;
    return;
  }
  if (s.upNextNotified === next) return;
  s.upNextNotified = next;
  tx.notice(next, 'up_next', 'You’re up next — your track plays after this one.');
  tx.effect({ type: 'refreshSet', userId: next });
}

/** The next N spins in room order (DJ + their next track). */
export function computeUpNext(s: RoomState, count: number = TIMING.upNextCount): UpNextItem[] {
  const out: UpNextItem[] = [];
  const used: Record<string, number> = {};
  let after = s.activeSlot;
  for (let k = 0; k < count; k++) {
    const order = rotationOrder(s.booth, after);
    if (!order.length) break;
    const slot = order[0]!;
    const dj = s.booth[slot]!.userId!;
    const preview = s.sets[dj];
    const allowed = (preview?.tracks ?? []).filter((t) => trackAllowed(s, t).ok);
    const n = used[dj] ?? 0;
    out.push({ djUserId: dj, track: allowed[n] ?? null });
    used[dj] = n + 1;
    after = slot;
  }
  return out;
}

export function tally(s: RoomState, now: number): Tally & { eligibleSkips: number; eligibleHype: number } {
  const cur = s.current;
  let hype = 0;
  let skip = 0;
  let eligibleSkips = 0;
  let eligibleHype = 0;
  const eligible = Object.values(s.members).filter((m) => m.userId !== cur?.djUserId && isEligible(m, s.settings, now));
  const eligibleIds = new Set(eligible.map((m) => m.userId));
  if (cur) {
    for (const [uid, v] of Object.entries(cur.votes)) {
      if (v.value === 'hype') {
        hype++;
        if (eligibleIds.has(uid)) eligibleHype++;
      } else {
        skip++;
        if (eligibleIds.has(uid)) eligibleSkips++;
      }
    }
  }
  return { hype, skip, eligibleVoters: eligible.length, eligibleSkips, eligibleHype };
}

function vote(tx: Tx, cmd: Extract<Command, { type: 'vote' }>) {
  const s = tx.s;
  const m = s.members[cmd.userId];
  if (!m) throw new SpinroomError('not_present', 'Join the room to vote');
  // FR-L2: Slack and MCP votes refresh remote presence.
  if (cmd.surface !== 'web') m.remoteUntil = Math.max(m.remoteUntil, tx.now + s.settings.remotePresenceMs);
  if (!isPresent(m, tx.now)) throw new SpinroomError('not_present', 'Join the room to vote');
  const cur = s.current;
  if (!cur || (cmd.spinId !== 'current' && cur.id !== cmd.spinId)) throw new SpinroomError('spin_not_current', 'That spin is over');
  if (cur.djUserId === cmd.userId) throw new SpinroomError('cannot_vote_own_spin', 'DJs can’t vote on their own spin');
  const before = cur.votes[cmd.userId]?.value ?? null;
  if (cmd.value === null) delete cur.votes[cmd.userId];
  else cur.votes[cmd.userId] = { value: cmd.value, surface: cmd.surface };
  if (before !== cmd.value) tx.effect({ type: 'vote', spinId: cur.id, userId: cmd.userId, value: cmd.value, surface: cmd.surface });
  const t = tally(s, tx.now);
  tx.emit({ type: 'votes.changed', spinId: cur.id, tally: { hype: t.hype, skip: t.skip, eligibleVoters: t.eligibleVoters } });
  checkAutoSkip(tx);
}

/** FR-V3: Skip ≥ ratio of eligible voters and ≥ minSkips (eligible votes only, FR-L3). */
function checkAutoSkip(tx: Tx) {
  const s = tx.s;
  if (!s.current) return;
  const t = tally(s, tx.now);
  if (t.eligibleVoters === 0) return;
  if (t.eligibleSkips >= s.settings.minSkips && t.eligibleSkips >= s.settings.skipRatio * t.eligibleVoters) endSpin(tx, 'auto_skip');
}

function endSpin(tx: Tx, reason: EndReason, opts: { refill?: boolean } = {}) {
  const s = tx.s;
  const cur = s.current;
  if (!cur) return;
  const t = tally(s, tx.now);
  const fade = reason === 'completed' ? 0 : TIMING.fadeMs;
  s.current = null;
  tx.emit({ type: 'spin.ended', spinId: cur.id, reason, hype: t.hype, skip: t.skip, eligibleVoters: t.eligibleVoters, fadeMs: fade });
  tx.effect({ type: 'spinEnded', spinId: cur.id, reason, endedAt: tx.now, hype: t.hype, skip: t.skip, eligibleVoters: t.eligibleVoters });

  // FR-V5: Hype-heavy spins earn the DJ a point.
  if (t.eligibleVoters > 0 && t.eligibleHype > 0 && t.eligibleHype >= s.settings.hypeRatio * t.eligibleVoters) {
    tx.effect({ type: 'awardPoints', userId: cur.djUserId, points: 1, spinId: cur.id });
  }

  const slot = s.booth[cur.slot];
  if (slot && slot.userId === cur.djUserId && reason !== 'dj_left') {
    if (reason === 'auto_skip') slot.consecutiveSkips++;
    else if (reason === 'completed') slot.consecutiveSkips = 0;
    tx.boothDirty = true;

    if (slot.consecutiveSkips >= s.settings.bounceAfter) {
      // FR-V4: bounce to the back of the queue with a cooldown.
      const until = tx.now + s.settings.bounceCooldownMs;
      s.booth[cur.slot] = emptySlot();
      s.cooldowns[cur.djUserId] = until;
      s.queue.push({ userId: cur.djUserId, joinedAt: tx.now, cooldownUntil: until });
      tx.queueDirty = true;
      tx.emit({ type: 'dj.bounced', userId: cur.djUserId, cooldownUntil: until });
      tx.notice(cur.djUserId, 'bounced', 'The crowd skipped your last spins, so you’re back in the queue for a few minutes.');
    } else if (
      s.settings.turnLimit &&
      slot.spinsThisTurn >= s.settings.turnLimit &&
      s.queue.some((q) => (q.cooldownUntil ?? 0) <= tx.now && q.userId !== cur.djUserId)
    ) {
      // FR-D5: turn limit returns the DJ to the back of the queue when others are waiting.
      s.booth[cur.slot] = emptySlot();
      s.queue.push({ userId: cur.djUserId, joinedAt: tx.now, cooldownUntil: null });
      tx.queueDirty = true;
      tx.notice(cur.djUserId, 'turn_over', 'Turn over — you’re back in the DJ queue.');
    }
  }
  if (opts.refill === false) {
    tx.fadePending = fade > 0;
    return;
  }
  startNext(tx, fade > 0);
}

function setStatus(tx: Tx, status: RoomState['status']) {
  if (tx.s.status === status) return;
  tx.s.status = status;
  tx.emit({ type: 'room.status_changed', status });
}

function resume(tx: Tx) {
  tx.s.paused = false;
  setStatus(tx, tx.s.current ? 'playing' : 'idle');
  startNext(tx, false);
}

function changeSettings(tx: Tx, settings: RoomSettings) {
  const s = tx.s;
  s.settings = settings;
  if (settings.boothSlots !== s.booth.length) {
    if (settings.boothSlots > s.booth.length) {
      while (s.booth.length < settings.boothSlots) s.booth.push(emptySlot());
    } else {
      const removed = s.booth.splice(settings.boothSlots);
      // DJs from removed slots go to the front of the queue.
      const back = removed.filter((b) => b.userId).map((b) => ({ userId: b.userId!, joinedAt: tx.now, cooldownUntil: null }));
      s.queue.unshift(...back);
      if (back.length) tx.queueDirty = true;
      if (s.current && s.current.slot >= settings.boothSlots) s.current.slot = -1;
      if (s.activeSlot !== null && s.activeSlot >= settings.boothSlots) s.activeSlot = settings.boothSlots - 1;
    }
    tx.boothDirty = true;
  }
  tx.upNextDirty = true;
}

// ------------------------------------------------------------------ sweep: runs after every command

function sweep(tx: Tx) {
  const s = tx.s;
  const now = tx.now;

  // Expire cooldowns.
  for (const [uid, until] of Object.entries(s.cooldowns)) if (until <= now) delete s.cooldowns[uid];
  for (const q of s.queue) {
    if (q.cooldownUntil !== null && q.cooldownUntil <= now) {
      q.cooldownUntil = null;
      tx.queueDirty = true;
    }
  }

  // Presence transitions, absence tracking, live speakers.
  let anySpeaker = false;
  for (const m of Object.values(s.members)) {
    const present = isPresent(m, now);
    if (speakerLive(m, now)) anySpeaker = true;
    if (present) m.absentSince = null;
    else m.absentSince ??= now;
  }
  if (anySpeaker) s.lastSpeakerLiveAt = Math.max(s.lastSpeakerLiveAt, now);

  // FR-D4: DJs (and queued members) absent for too long lose their place.
  for (const m of Object.values(s.members)) {
    if (m.absentSince === null || now - m.absentSince <= s.settings.djPresenceDropMs) continue;
    if (s.booth.some((b) => b.userId === m.userId)) {
      removeFromBooth(tx, m.userId, 'removed_from_booth', 'You were away, so you left the booth.');
    }
    if (s.queue.some((q) => q.userId === m.userId)) {
      s.queue = s.queue.filter((q) => q.userId !== m.userId);
      tx.queueDirty = true;
    }
  }

  // A forgotten pause doesn't hold up the booth forever.
  if (s.current?.pausedAt && now - s.current.pausedAt >= TIMING.maxPauseMs) resumeSpin(tx);

  // Safety net: a spin overdue past its end (missed timer) completes now.
  if (s.current && now >= spinEndsAt(s.current) + 1000) endSpin(tx, 'completed');

  // FR-L1: pause when nobody has had a live speaker for a while; resume on the next live speaker.
  if (!s.paused && !anySpeaker && now - s.lastSpeakerLiveAt > s.settings.pauseAfterNoSpeakerMs && s.booth.some((b) => b.userId)) {
    s.paused = true;
    setStatus(tx, 'paused');
  } else if (s.paused && (anySpeaker || !s.booth.some((b) => b.userId))) {
    resume(tx);
  }

  fillBooth(tx);
  if (!s.current && !s.paused) startNext(tx, false);
  if (s.current) checkAutoSkip(tx);

  // Emit presence changes.
  for (const m of Object.values(s.members)) {
    const p = presenceOf(m, now);
    const e = isEligible(m, s.settings, now);
    if (p !== m.presence || e !== m.eligible) {
      m.presence = p;
      m.eligible = e;
      tx.emit({ type: 'presence.changed', userId: m.userId, state: p, eligible: e });
    }
  }
  // Drop long-away members from live state.
  for (const m of Object.values(s.members)) {
    if (m.absentSince !== null && now - m.absentSince > AWAY_PRUNE_MS && !s.booth.some((b) => b.userId === m.userId)) {
      delete s.members[m.userId];
      delete s.sets[m.userId];
      tx.emit({ type: 'presence.changed', userId: m.userId, state: 'away', eligible: false, left: true });
    }
  }
}

function finish(tx: Tx, prev: RoomState) {
  const s = tx.s;
  if (tx.boothDirty && JSON.stringify(s.booth) !== JSON.stringify(prev.booth)) {
    tx.emit({ type: 'booth.changed', booth: boothView(s), activeSlot: s.activeSlot });
    tx.upNextDirty = true;
  } else if (s.activeSlot !== prev.activeSlot) {
    tx.emit({ type: 'booth.changed', booth: boothView(s), activeSlot: s.activeSlot });
  }
  if (tx.queueDirty && JSON.stringify(s.queue) !== JSON.stringify(prev.queue)) {
    tx.emit({ type: 'dj_queue.changed', queue: s.queue.map((q) => ({ ...q })) });
  }
  if (tx.upNextDirty) {
    const upNext = computeUpNext(s);
    if (JSON.stringify(upNext) !== JSON.stringify(computeUpNext(prev))) tx.emit({ type: 'up_next.changed', upNext });
    if (s.current) notifyUpNext(tx, upNext);
  }
}

export function boothView(s: RoomState) {
  return s.booth.map((b, slot) => ({ slot, userId: b.userId, spinsThisTurn: b.spinsThisTurn, consecutiveSkips: b.consecutiveSkips }));
}

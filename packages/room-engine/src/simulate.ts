import { DEFAULT_ROOM_SETTINGS, SpinroomError, type RoomEventBody, type RoomSettings, type Role, type Track } from '@spinroom/contracts';
import { apply, createRoomState, SET_PREVIEW_SIZE } from './engine.js';
import type { Command, Effect, RoomState } from './types.js';

export function makeTrack(n: number, extra: Partial<Track> = {}): Track {
  const id = `t${String(n).padStart(6, '0')}`;
  return {
    uri: `spotify:track:${id}`,
    title: `Track ${n}`,
    artists: [`Artist ${n % 7}`],
    album: 'A',
    artUrl: null,
    durationMs: 180_000,
    explicit: false,
    playable: true,
    ...extra,
  };
}

/**
 * Drives the pure engine like the API runtime does: a manual clock, timers, and full
 * cyclic sets per member (FR-D6 wrap-around). Used by unit tests and the bot simulation.
 */
export class EngineHarness {
  state: RoomState;
  now: number;
  events: (RoomEventBody & { seq: number; at: number })[] = [];
  effects: Effect[] = [];
  timers: { at: number; spinId: string }[] = [];
  sets: Record<string, { tracks: Track[]; position: number }> = {};
  points: Record<string, number> = {};
  persistedSpins: { id: string; reason?: string; hype?: number; skip?: number }[] = [];
  private seq = 0;
  private ids = 0;
  private checkedEvents = 0;

  constructor(settings: Partial<RoomSettings> = {}, start = 1_700_000_000_000) {
    this.now = start;
    this.state = createRoomState('room-1', { ...DEFAULT_ROOM_SETTINGS, ...settings }, start);
  }

  run(cmd: Command): RoomEventBody[] {
    const r = apply(this.state, cmd, { now: this.now, newId: () => `spin-${++this.ids}` });
    this.state = r.state;
    for (const e of r.events) this.events.push({ ...e, seq: ++this.seq, at: this.now });
    this.effects.push(...r.effects);
    const follow: Command[] = [];
    for (const ef of r.effects) {
      if (ef.type === 'schedule') this.timers.push({ at: ef.at, spinId: ef.spinId });
      else if (ef.type === 'advanceSet') {
        const set = this.sets[ef.userId];
        if (set && set.tracks.length) set.position = (set.position + ef.by) % set.tracks.length;
        follow.push({ type: 'setUpdated', userId: ef.userId, preview: this.preview(ef.userId) });
      } else if (ef.type === 'awardPoints') this.points[ef.userId] = (this.points[ef.userId] ?? 0) + ef.points;
      else if (ef.type === 'spinStarted') this.persistedSpins.push({ id: ef.spin.id });
      else if (ef.type === 'spinEnded') {
        const p = this.persistedSpins.find((x) => x.id === ef.spinId);
        if (p) Object.assign(p, { reason: ef.reason, hype: ef.hype, skip: ef.skip });
      }
    }
    const out = [...r.events];
    for (const c of follow) out.push(...this.run(c));
    return out;
  }

  /** Run and expect a SpinroomError code. */
  fails(cmd: Command): string {
    try {
      this.run(cmd);
    } catch (e) {
      if (e instanceof SpinroomError) return e.code;
      throw e;
    }
    throw new Error(`expected ${cmd.type} to fail`);
  }

  preview(userId: string) {
    const set = this.sets[userId];
    if (!set || set.tracks.length === 0) return { tracks: [], length: 0 };
    const n = Math.min(SET_PREVIEW_SIZE, set.tracks.length);
    const tracks = Array.from({ length: n }, (_, i) => set.tracks[(set.position + i) % set.tracks.length]!);
    return { tracks, length: set.tracks.length };
  }

  setSet(userId: string, tracks: Track[]) {
    this.sets[userId] = { tracks, position: 0 };
    this.run({ type: 'setUpdated', userId, preview: this.preview(userId) });
  }

  /** A present member with a live speaker and a set. */
  addListener(userId: string, opts: { role?: Role; tracks?: Track[]; speaker?: boolean } = {}) {
    this.run({ type: 'connect', userId, role: opts.role ?? 'member' });
    if (opts.speaker !== false) this.run({ type: 'speakerHeartbeat', userId, live: true, audible: true });
    if (opts.tracks) this.setSet(userId, opts.tracks);
  }

  /** Advance the clock, firing due timers and periodic heartbeats/ticks. */
  advance(ms: number, opts: { heartbeat?: boolean } = {}) {
    const end = this.now + ms;
    while (this.now < end) {
      const nextTimer = this.timers.filter((t) => t.at > this.now && t.at <= end).sort((a, b) => a.at - b.at)[0];
      const step = Math.min(end, nextTimer?.at ?? end, this.now + 15_000);
      this.now = step;
      for (const t of this.timers.filter((t) => t.at <= this.now)) {
        this.timers = this.timers.filter((x) => x !== t);
        this.run({ type: 'timer', spinId: t.spinId });
      }
      if (opts.heartbeat !== false) {
        for (const m of Object.values(this.state.members)) {
          if (m.speakerAt !== null && this.now - m.speakerAt >= 15_000) this.run({ type: 'speakerHeartbeat', userId: m.userId, live: true, audible: true });
        }
      }
      this.run({ type: 'tick' });
    }
  }

  /** Finish the current spin by letting its timer fire. */
  playThrough() {
    const cur = this.state.current;
    if (!cur) throw new Error('nothing playing');
    this.advance(cur.startedAtServerMs + cur.durationMs + 2000 - this.now + 1);
  }

  eventsOf<T extends RoomEventBody['type']>(type: T) {
    return this.events.filter((e) => e.type === type) as Extract<RoomEventBody & { seq: number; at: number }, { type: T }>[];
  }

  /** Invariants that must hold after every command. */
  checkInvariants() {
    const s = this.state;
    const boothUsers = s.booth.map((b) => b.userId).filter(Boolean);
    if (new Set(boothUsers).size !== boothUsers.length) throw new Error('duplicate booth user');
    const queueUsers = s.queue.map((q) => q.userId);
    if (new Set(queueUsers).size !== queueUsers.length) throw new Error('duplicate queue user');
    for (const u of boothUsers) if (queueUsers.includes(u!)) throw new Error(`user ${u} both in booth and queue`);
    if (s.booth.length !== s.settings.boothSlots) throw new Error('booth size mismatch');
    if (s.current) {
      if (!s.booth.some((b) => b.userId === s.current!.djUserId)) throw new Error('current DJ not at booth');
      if (s.current.votes[s.current.djUserId]) throw new Error('DJ voted on own spin');
    }
    if (s.status === 'playing' && !s.current && !s.paused) {
      // allowed transiently only if booth empty
      if (s.booth.some((b) => b.userId)) throw new Error('playing without a current spin');
    }
    for (let i = Math.max(1, this.checkedEvents); i < this.events.length; i++)
      if (this.events[i]!.seq !== this.events[i - 1]!.seq + 1) throw new Error('seq gap');
    this.checkedEvents = this.events.length;
  }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bot simulation (Phase 2 acceptance): `bots` members join, queue, vote, leave and rejoin
 * at random until `spins` spins have finished. Throws on any invariant violation.
 */
export function simulate(opts: { bots: number; spins: number; seed?: number; settings?: Partial<RoomSettings> }) {
  const rand = rng(opts.seed ?? 42);
  const h = new EngineHarness(opts.settings);
  const users = Array.from({ length: opts.bots }, (_, i) => `bot-${i}`);
  let trackN = 0;
  for (const u of users) {
    const tracks = Array.from({ length: 1 + Math.floor(rand() * 6) }, () =>
      makeTrack(++trackN, { durationMs: 20_000 + Math.floor(rand() * 200_000), playable: rand() > 0.03, explicit: rand() < 0.05 }),
    );
    h.addListener(u, { tracks, speaker: rand() > 0.2 });
  }
  const errors: Record<string, number> = {};
  const finished = () => h.eventsOf('spin.ended').length;
  let steps = 0;
  // Each spin gets a crowd mood so some tracks get panned (exercises auto-skip and bounce).
  let moodSpin: string | null = null;
  let skipBias = 0.4;
  while (finished() < opts.spins) {
    if (++steps > 200_000) throw new Error('simulation did not converge');
    if (h.state.current && h.state.current.id !== moodSpin) {
      moodSpin = h.state.current.id;
      skipBias = rand() < 0.3 ? 0.9 : 0.15;
    }
    const u = users[Math.floor(rand() * users.length)]!;
    const r = rand();
    try {
      if (r < 0.1) h.run({ type: 'queueJoin', userId: u });
      else if (r < 0.12) h.run({ type: 'queueLeave', userId: u });
      else if (r < 0.7) {
        if (h.state.current) {
          const v = rand();
          h.run({
            type: 'vote',
            userId: u,
            spinId: 'current',
            value: v < skipBias ? 'skip' : v < 0.95 ? 'hype' : null,
            surface: rand() < 0.8 ? 'web' : rand() < 0.5 ? 'slack' : 'mcp',
          });
        } else h.advance(5000);
      } else if (r < 0.71) h.run({ type: 'leave', userId: u });
      else if (r < 0.56) {
        h.run({ type: 'connect', userId: u, role: 'member' });
        if (rand() > 0.3) h.run({ type: 'speakerHeartbeat', userId: u, live: true, audible: true });
        h.setSet(u, h.sets[u]?.tracks ?? [makeTrack(++trackN)]);
      } else if (r < 0.745) h.run({ type: 'disconnect', userId: u });
      else if (r < 0.75) {
        if (h.state.current) h.run({ type: 'skip', userId: h.state.current.djUserId, by: 'dj' });
      } else if (r < 0.752) h.run({ type: 'skip', userId: u, by: 'mod' });
      else h.advance(1000 + Math.floor(rand() * 20_000));
    } catch (e) {
      if (!(e instanceof SpinroomError)) throw e;
      errors[e.code] = (errors[e.code] ?? 0) + 1;
    }
    h.checkInvariants();
  }
  return { harness: h, errors, spins: finished(), steps };
}

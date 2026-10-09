import { TIMING } from '@spinroom/contracts';
import { describe, expect, it } from 'vitest';
import { computeUpNext, EngineHarness, makeTrack, simulate } from './index.js';

const tracks = (from: number, n: number) => Array.from({ length: n }, (_, i) => makeTrack(from + i));

/** Room with a DJ (`dj`) on the booth playing, plus `n` listeners with live speakers. */
function playingRoom(n = 4, settings = {}) {
  const h = new EngineHarness(settings);
  h.addListener('dj', { tracks: tracks(1, 3) });
  for (let i = 0; i < n; i++) h.addListener(`l${i}`);
  h.run({ type: 'queueJoin', userId: 'dj' });
  return h;
}

describe('rooms (FR-R5)', () => {
  it('stays idle with an empty booth', () => {
    const h = new EngineHarness();
    h.addListener('a');
    expect(h.state.status).toBe('idle');
    expect(h.state.current).toBeNull();
  });

  it('rejects joins beyond maxPresent (FR-R4)', () => {
    const h = new EngineHarness({ maxPresent: 2 });
    h.addListener('a');
    h.addListener('b');
    expect(h.fails({ type: 'connect', userId: 'c', role: 'member' })).toBe('room_full');
  });
});

describe('DJ rotation', () => {
  it('FR-D1: needs a playable track to join the queue', () => {
    const h = new EngineHarness();
    h.addListener('a');
    expect(h.fails({ type: 'queueJoin', userId: 'a' })).toBe('crate_empty');
    h.setSet('a', [makeTrack(1, { playable: false })]);
    expect(h.fails({ type: 'queueJoin', userId: 'a' })).toBe('crate_empty');
    h.setSet('a', [makeTrack(2)]);
    h.run({ type: 'queueJoin', userId: 'a' });
    expect(h.state.booth[0]!.userId).toBe('a');
  });

  it('FR-D1: refuses absent members and duplicates', () => {
    const h = new EngineHarness();
    expect(h.fails({ type: 'queueJoin', userId: 'ghost' })).toBe('not_present');
    h.addListener('a', { tracks: tracks(1, 1) });
    h.run({ type: 'queueJoin', userId: 'a' });
    expect(h.fails({ type: 'queueJoin', userId: 'a' })).toBe('already_in_queue');
  });

  it('FR-D2: the first in queue takes an open slot', () => {
    const h = new EngineHarness({ boothSlots: 1 });
    h.addListener('a', { tracks: tracks(1, 2) });
    h.addListener('b', { tracks: tracks(10, 2) });
    h.addListener('c', { tracks: tracks(20, 2) });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.run({ type: 'queueJoin', userId: 'b' });
    h.run({ type: 'queueJoin', userId: 'c' });
    expect(h.state.queue.map((q) => q.userId)).toEqual(['b', 'c']);
    h.run({ type: 'queueLeave', userId: 'a' });
    expect(h.state.booth[0]!.userId).toBe('b');
    expect(h.state.queue.map((q) => q.userId)).toEqual(['c']);
  });

  it('FR-D3: round-robin in slot order, one spin per turn', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: tracks(1, 3) });
    h.addListener('b', { tracks: tracks(10, 3) });
    h.addListener('c', { tracks: tracks(20, 3) });
    for (const u of ['a', 'b', 'c']) h.run({ type: 'queueJoin', userId: u });
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      order.push(h.state.current!.djUserId);
      h.playThrough();
    }
    expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('FR-D4: a DJ can leave mid-spin (dj_left) and the next DJ plays after a fade', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: tracks(1, 3) });
    h.addListener('b', { tracks: tracks(10, 3) });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.run({ type: 'queueJoin', userId: 'b' });
    const spinA = h.state.current!;
    h.run({ type: 'queueLeave', userId: 'a' });
    const ended = h.eventsOf('spin.ended').at(-1)!;
    expect(ended).toMatchObject({ spinId: spinA.id, reason: 'dj_left', fadeMs: TIMING.fadeMs });
    expect(h.state.current!.djUserId).toBe('b');
    expect(h.state.current!.startedAtServerMs).toBe(h.now + TIMING.fadeMs);
    expect(h.state.booth.find((b) => b.userId === 'a')).toBeUndefined();
  });

  it('FR-D4: a DJ away for over 60 s leaves the booth', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: tracks(1, 3) });
    h.addListener('b', { tracks: tracks(10, 3) });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.run({ type: 'queueJoin', userId: 'b' });
    h.run({ type: 'disconnect', userId: 'b' });
    h.run({ type: 'speakerHeartbeat', userId: 'b', live: false, audible: false });
    h.advance(50_000);
    expect(h.state.booth.some((x) => x.userId === 'b')).toBe(true);
    h.advance(15_000);
    expect(h.state.booth.some((x) => x.userId === 'b')).toBe(false);
    expect(h.eventsOf('user.notice').some((n) => n.userId === 'b' && n.kind === 'removed_from_booth')).toBe(true);
  });

  it('FR-D5: turn limit returns the DJ to the back of the queue only when others wait', () => {
    const h = new EngineHarness({ boothSlots: 1, turnLimit: 2 });
    h.addListener('a', { tracks: tracks(1, 5) });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.playThrough();
    h.playThrough();
    expect(h.state.current!.djUserId).toBe('a'); // nobody waiting → keeps playing
    h.addListener('b', { tracks: tracks(10, 3) });
    h.run({ type: 'queueJoin', userId: 'b' });
    h.playThrough();
    expect(h.state.current!.djUserId).toBe('b');
    expect(h.state.queue.map((q) => q.userId)).toEqual(['a']);
  });

  it('FR-D6: plays the set in order and wraps to the top', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: tracks(1, 2) });
    h.run({ type: 'queueJoin', userId: 'a' });
    const played: string[] = [];
    for (let i = 0; i < 4; i++) {
      played.push(h.state.current!.track.title);
      h.playThrough();
    }
    expect(played).toEqual(['Track 1', 'Track 2', 'Track 1', 'Track 2']);
  });

  it('FR-D7: tracks longer than the max are not played', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: [makeTrack(1, { durationMs: 11 * 60_000 }), makeTrack(2)] });
    h.run({ type: 'queueJoin', userId: 'a' });
    expect(h.state.current!.track.title).toBe('Track 2');
  });

  it('FR-D8: blocks a repeat within the window when enabled', () => {
    const h = new EngineHarness({ noRepeatWindow: 20 });
    const shared = makeTrack(1);
    h.addListener('a', { tracks: [shared, makeTrack(2)] });
    h.addListener('b', { tracks: [shared, makeTrack(3)] });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.run({ type: 'queueJoin', userId: 'b' });
    expect(h.state.current!.track.uri).toBe(shared.uri);
    h.playThrough();
    expect(h.state.current!.djUserId).toBe('b');
    expect(h.state.current!.track.title).toBe('Track 3');
  });

  it('FR-C3: skips unplayable tracks with a notice', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: [makeTrack(1, { playable: false }), makeTrack(2)] });
    h.run({ type: 'queueJoin', userId: 'a' });
    expect(h.state.current!.track.title).toBe('Track 2');
    expect(h.eventsOf('user.notice').some((n) => n.kind === 'track_skipped_unplayable')).toBe(true);
  });

  it('FR-L5: a DJ whose set runs out steps down with a notice', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: tracks(1, 1) });
    h.addListener('b', { tracks: tracks(10, 2) });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.run({ type: 'queueJoin', userId: 'b' });
    h.setSet('a', []); // emptied in Spotify
    h.playThrough(); // a's spin ends, b plays
    h.playThrough(); // a's turn: nothing → steps down, b plays again
    expect(h.state.booth.some((x) => x.userId === 'a')).toBe(false);
    expect(h.state.current!.djUserId).toBe('b');
    expect(h.eventsOf('user.notice').some((n) => n.userId === 'a' && n.kind === 'crate_ran_out')).toBe(true);
  });

  it('FR-L6: blocks explicit tracks when the room setting is on', () => {
    const h = new EngineHarness({ blockExplicit: true });
    h.addListener('a', { tracks: [makeTrack(1, { explicit: true }), makeTrack(2)] });
    h.run({ type: 'queueJoin', userId: 'a' });
    expect(h.state.current!.track.title).toBe('Track 2');
  });

  it('FR-L4: the next DJ gets an up-next notice one spin ahead', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: tracks(1, 3) });
    h.addListener('b', { tracks: tracks(10, 3) });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.run({ type: 'queueJoin', userId: 'b' });
    const notices = h.eventsOf('user.notice').filter((n) => n.kind === 'up_next');
    expect(notices.map((n) => n.userId)).toEqual(['b']);
    expect(h.effects.some((e) => e.type === 'refreshSet' && e.userId === 'b')).toBe(true);
  });

  it('computes Up next as the next three spins in room order', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: tracks(1, 3) });
    h.addListener('b', { tracks: tracks(10, 3) });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.run({ type: 'queueJoin', userId: 'b' });
    const up = computeUpNext(h.state);
    expect(up.map((u) => [u.djUserId, u.track?.title])).toEqual([
      ['b', 'Track 10'],
      ['a', 'Track 2'],
      ['b', 'Track 11'],
    ]);
  });

  it('empty booth: the room goes idle when the last DJ leaves', () => {
    const h = playingRoom(1);
    h.run({ type: 'queueLeave', userId: 'dj' });
    expect(h.state.status).toBe('idle');
    expect(h.state.current).toBeNull();
  });
});

describe('voting', () => {
  it('FR-V1: one vote per member per spin, changeable, DJ excluded', () => {
    const h = playingRoom(3);
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'hype', surface: 'web' });
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'hype', surface: 'web' });
    expect(h.eventsOf('votes.changed').at(-1)!.tally).toMatchObject({ hype: 1, skip: 0 });
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'skip', surface: 'web' });
    expect(h.eventsOf('votes.changed').at(-1)!.tally).toMatchObject({ hype: 0, skip: 1 });
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: null, surface: 'web' });
    expect(h.eventsOf('votes.changed').at(-1)!.tally).toMatchObject({ hype: 0, skip: 0 });
    expect(h.fails({ type: 'vote', userId: 'dj', spinId: 'current', value: 'hype', surface: 'web' })).toBe('cannot_vote_own_spin');
    expect(h.fails({ type: 'vote', userId: 'l1', spinId: 'old-spin', value: 'hype', surface: 'web' })).toBe('spin_not_current');
  });

  it('FR-V2: only live speakers or recent listeners count as eligible', () => {
    const h = playingRoom(2);
    h.addListener('remote', { speaker: false });
    expect(h.eventsOf('votes.changed').length).toBe(0);
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'hype', surface: 'web' });
    expect(h.eventsOf('votes.changed').at(-1)!.tally.eligibleVoters).toBe(2); // l0, l1 — not remote, not DJ
    // A member who heard audio within 10 minutes stays eligible after their speaker closes.
    h.run({ type: 'speakerHeartbeat', userId: 'l1', live: false, audible: false });
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'skip', surface: 'web' });
    expect(h.eventsOf('votes.changed').at(-1)!.tally.eligibleVoters).toBe(2);
  });

  it('FR-V3: auto-skip at ≥ 50% of eligible voters and ≥ 2 Skips (tie fires)', () => {
    const h = playingRoom(4);
    const spin = h.state.current!.id;
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'skip', surface: 'web' });
    expect(h.state.current!.id).toBe(spin);
    h.run({ type: 'vote', userId: 'l1', spinId: 'current', value: 'skip', surface: 'web' }); // 2 of 4 = 50%
    const ended = h.eventsOf('spin.ended').at(-1)!;
    expect(ended).toMatchObject({ spinId: spin, reason: 'auto_skip', fadeMs: 3000, skip: 2 });
  });

  it('FR-V3: below 50% does not skip; minSkips applies in tiny rooms', () => {
    const h = playingRoom(5);
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'skip', surface: 'web' });
    h.run({ type: 'vote', userId: 'l1', spinId: 'current', value: 'skip', surface: 'web' });
    expect(h.eventsOf('spin.ended').length).toBe(0); // 2/5 = 40%
    const tiny = playingRoom(1);
    tiny.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'skip', surface: 'web' });
    expect(tiny.eventsOf('spin.ended').length).toBe(0); // 100% but only 1 Skip
  });

  it('FR-L3: Slack/MCP votes count toward auto-skip only with a live speaker', () => {
    const h = playingRoom(2);
    h.run({ type: 'remoteAction', userId: 'r1', role: 'member' });
    h.run({ type: 'remoteAction', userId: 'r2', role: 'member' });
    h.run({ type: 'vote', userId: 'r1', spinId: 'current', value: 'skip', surface: 'slack' });
    h.run({ type: 'vote', userId: 'r2', spinId: 'current', value: 'skip', surface: 'mcp' });
    expect(h.eventsOf('spin.ended').length).toBe(0);
    expect(h.eventsOf('votes.changed').at(-1)!.tally).toMatchObject({ skip: 2, eligibleVoters: 2 });
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'skip', surface: 'web' });
    expect(h.eventsOf('spin.ended').length).toBe(0); // 1 eligible skip
    h.run({ type: 'vote', userId: 'l1', spinId: 'current', value: 'skip', surface: 'web' });
    expect(h.eventsOf('spin.ended').at(-1)!.reason).toBe('auto_skip');
  });

  it('FR-L2: remote presence lasts 15 minutes after the last action', () => {
    const h = playingRoom(1);
    h.run({ type: 'remoteAction', userId: 'r', role: 'member' });
    h.advance(14 * 60_000);
    expect(h.state.members.r!.presence).toBe('remote');
    h.advance(2 * 60_000);
    expect(h.state.members.r?.presence ?? 'away').toBe('away');
  });

  it('FR-V4: two auto-skips in a row bounce the DJ with a 5-minute cooldown', () => {
    const h = playingRoom(4);
    h.addListener('next', { tracks: tracks(50, 3) });
    h.run({ type: 'queueJoin', userId: 'next' });
    const skip = () => {
      for (const u of ['l0', 'l1', 'l2']) h.run({ type: 'vote', userId: u, spinId: 'current', value: 'skip', surface: 'web' });
    };
    skip(); // dj auto-skipped #1, next plays
    expect(h.state.current!.djUserId).toBe('next');
    h.playThrough(); // dj again
    expect(h.state.current!.djUserId).toBe('dj');
    expect(h.state.booth.find((b) => b.userId === 'dj')!.consecutiveSkips).toBe(1);
    // A completed spin in between resets the streak:
    h.playThrough();
    h.playThrough();
    expect(h.state.current!.djUserId).toBe('dj');
    skip();
    expect(h.state.booth.some((b) => b.userId === 'dj')).toBe(true);
    h.playThrough();
    skip();
    const bounced = h.eventsOf('dj.bounced').at(-1)!;
    expect(bounced).toMatchObject({ userId: 'dj', cooldownUntil: h.now + 5 * 60_000 });
    expect(h.state.booth.some((b) => b.userId === 'dj')).toBe(false);
    expect(h.state.queue.at(-1)).toMatchObject({ userId: 'dj', cooldownUntil: h.now + 5 * 60_000 });
    // While cooling down they can't take a slot; leaving and rejoining is refused.
    h.run({ type: 'queueLeave', userId: 'dj' });
    expect(h.fails({ type: 'queueJoin', userId: 'dj' })).toBe('on_cooldown');
    h.advance(5 * 60_000 + 1000);
    h.run({ type: 'queueJoin', userId: 'dj' });
    expect(h.state.booth.some((b) => b.userId === 'dj')).toBe(true);
  });

  it('FR-V5: a Hype-heavy spin earns the DJ a point', () => {
    const h = playingRoom(4);
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'hype', surface: 'web' });
    h.run({ type: 'vote', userId: 'l1', spinId: 'current', value: 'hype', surface: 'web' });
    h.playThrough();
    expect(h.points.dj).toBe(1);
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'hype', surface: 'web' });
    h.playThrough();
    expect(h.points.dj).toBe(1); // 1 of 4 is not Hype-heavy
  });

  it('FR-V7: the DJ can skip their spin; moderators can end any spin', () => {
    const h = playingRoom(2);
    expect(h.fails({ type: 'skip', userId: 'l0', by: 'dj' })).toBe('forbidden');
    h.run({ type: 'skip', userId: 'dj', by: 'dj' });
    expect(h.eventsOf('spin.ended').at(-1)!.reason).toBe('dj_skip');
    h.run({ type: 'skip', userId: 'l0', by: 'mod' });
    expect(h.eventsOf('spin.ended').at(-1)!.reason).toBe('mod_skip');
  });

  it('the DJ (or a moderator) can pause; a paused spin never ends, and resumes where it stopped', () => {
    const h = playingRoom(2);
    const cur = h.state.current!;
    h.advance(30_000);
    expect(h.fails({ type: 'pause', userId: 'l0', by: 'dj', paused: true })).toBe('forbidden');
    h.run({ type: 'pause', userId: 'dj', by: 'dj', paused: true });
    const pausedAt = h.now;
    expect(h.state.current!.pausedAt).toBe(pausedAt);
    expect(h.eventsOf('spin.playback').at(-1)).toMatchObject({ spinId: cur.id, pausedAtServerMs: pausedAt });
    // Far past its original end: still the same spin.
    h.advance(cur.durationMs);
    expect(h.state.current!.id).toBe(cur.id);
    h.run({ type: 'pause', userId: 'l0', by: 'mod', paused: false });
    const after = h.state.current!;
    expect(after.pausedAt).toBeNull();
    expect(after.startedAtServerMs).toBe(cur.startedAtServerMs + (h.now - pausedAt));
    expect(h.eventsOf('spin.playback').at(-1)).toMatchObject({ pausedAtServerMs: null, startedAtServerMs: after.startedAtServerMs });
    expect(h.effects.some((e) => e.type === 'spinShifted' && e.spinId === cur.id)).toBe(true);
    // The rest of the track plays out, then the next spin starts.
    h.advance(cur.durationMs - 30_000 - 5000);
    expect(h.state.current!.id).toBe(cur.id);
    h.advance(10_000);
    expect(h.state.current!.id).not.toBe(cur.id);
  });

  it('a forgotten pause resumes by itself after 10 minutes', () => {
    const h = playingRoom(1);
    h.run({ type: 'pause', userId: 'dj', by: 'dj', paused: true });
    h.advance(TIMING.maxPauseMs - 20_000);
    expect(h.state.current!.pausedAt).not.toBeNull();
    h.advance(30_000);
    expect(h.state.current!.pausedAt).toBeNull();
  });

  it('votes reset on each new spin', () => {
    const h = playingRoom(2);
    h.run({ type: 'vote', userId: 'l0', spinId: 'current', value: 'hype', surface: 'web' });
    h.playThrough();
    expect(h.state.current!.votes).toEqual({});
  });
});

describe('lifecycle', () => {
  it('advances on the timer at start + duration + 2 s grace', () => {
    const h = playingRoom(1);
    const cur = h.state.current!;
    h.advance(cur.durationMs + 1000);
    expect(h.state.current!.id).toBe(cur.id);
    h.advance(1500);
    expect(h.state.current!.id).not.toBe(cur.id);
  });

  it('FR-L1: pauses after 2 minutes without a live speaker and resumes on one', () => {
    const h = new EngineHarness();
    h.addListener('a', { tracks: [makeTrack(1, { durationMs: 30_000 }), makeTrack(2, { durationMs: 30_000 })] });
    h.run({ type: 'queueJoin', userId: 'a' });
    h.run({ type: 'speakerHeartbeat', userId: 'a', live: false, audible: false });
    h.run({ type: 'remoteAction', userId: 'a', role: 'member' }); // stay present as a remote
    h.advance(125_000, { heartbeat: false });
    expect(h.state.status).toBe('paused');
    const spinsBefore = h.eventsOf('spin.started').length;
    h.advance(60_000, { heartbeat: false });
    expect(h.eventsOf('spin.started').length).toBe(spinsBefore); // spins stop advancing
    expect(h.state.booth[0]!.userId).toBe('a'); // booth kept
    h.run({ type: 'speakerHeartbeat', userId: 'a', live: true, audible: true });
    expect(h.state.status).toBe('playing');
    expect(h.state.current).not.toBeNull();
  });

  it('booth size change moves extra DJs to the front of the queue', () => {
    const h = new EngineHarness();
    for (const u of ['a', 'b', 'c']) h.addListener(u, { tracks: tracks(u.charCodeAt(0) * 10, 2) });
    for (const u of ['a', 'b', 'c']) h.run({ type: 'queueJoin', userId: u });
    h.run({ type: 'settings', settings: { ...h.state.settings, boothSlots: 2 } });
    expect(h.state.booth.length).toBe(2);
    expect(h.state.queue[0]!.userId).toBe('c');
  });

  it('kicked members leave booth and queue', () => {
    const h = playingRoom(1);
    h.run({ type: 'leave', userId: 'dj', kicked: true });
    expect(h.state.members.dj).toBeUndefined();
    expect(h.eventsOf('user.notice').some((n) => n.kind === 'kicked')).toBe(true);
    expect(h.state.status).toBe('idle');
  });
});

describe('simulation (Phase 2 acceptance)', () => {
  it('50 bots run 100 spins without state errors', () => {
    const r = simulate({ bots: 50, spins: 100, seed: 7 });
    expect(r.spins).toBeGreaterThanOrEqual(100);
    const reasons = new Set(r.harness.eventsOf('spin.ended').map((e) => e.reason));
    expect(reasons.has('completed')).toBe(true);
    expect(reasons.has('auto_skip')).toBe(true);
  });

  it('holds invariants across seeds and settings', () => {
    for (const seed of [1, 2, 3]) simulate({ bots: 20, spins: 40, seed, settings: { boothSlots: 2, turnLimit: 2, noRepeatWindow: 5, blockExplicit: true } });
  });
});

import { describe, expect, it } from 'vitest';
import type { RoomSnapshot } from '@spinroom/contracts';
import { DEFAULT_ROOM_SETTINGS } from '@spinroom/contracts';
import { applyEvent, DriftController, ServerClock, SpinroomClient, ApiError, formatMs } from './index.js';

describe('ServerClock', () => {
  it('uses the median of the last 5 samples', () => {
    const c = new ServerClock();
    for (const s of [100, 5000, 110, 90, 105]) c.addSample(s);
    expect(c.offset).toBe(105);
    c.addSample(-9999);
    c.addSample(-9999);
    expect(c.offset).toBe(90);
  });
  it('computes offset from a round trip', () => {
    const c = new ServerClock();
    // sent at 1000, server says 2050 at the midpoint, received at 1100 → offset 1000
    c.addRoundTrip(1000, 2050, 1100);
    expect(c.offset).toBe(1000);
    expect(c.now(5000)).toBe(6000);
  });
});

describe('DriftController', () => {
  it('ignores drift under 500 ms', () => {
    expect(new DriftController().decide(10_000, 10_400).kind).toBe('none');
  });
  it('seeks over 500 ms', () => {
    expect(new DriftController().decide(10_000, 10_600)).toMatchObject({ kind: 'seek', positionMs: 10_000 });
  });
  it('reloads after two drifts over 3 s in a row', () => {
    const d = new DriftController();
    expect(d.decide(10_000, 14_000).kind).toBe('seek');
    expect(d.decide(15_000, 19_000).kind).toBe('reload');
    expect(d.decide(20_000, 24_000).kind).toBe('seek');
  });
  it('resets the streak after a good sample', () => {
    const d = new DriftController();
    d.decide(10_000, 14_000);
    d.decide(15_000, 15_100);
    expect(d.decide(20_000, 24_000).kind).toBe('seek');
  });
});

const snap = (): RoomSnapshot => ({
  seq: 1,
  serverNow: 0,
  room: { id: 'r', slug: 's', name: 'n', description: '', visibility: 'public', ownerId: 'o', settings: DEFAULT_ROOM_SETTINGS, createdAt: 0 },
  status: 'idle',
  members: [],
  booth: [],
  activeSlot: null,
  queue: [],
  currentSpin: null,
  tally: { hype: 0, skip: 0, eligibleVoters: 0 },
  upNext: [],
  recentChat: [],
  me: { role: 'member', vote: 'hype', speakerStatus: 'off', inQueue: false, boothSlot: null, cooldownUntil: null },
});

describe('applyEvent', () => {
  it('starts and ends spins, resets my vote', () => {
    const track = { uri: 'spotify:track:abc', title: 't', artists: ['a'], album: '', artUrl: null, durationMs: 1000, explicit: false, playable: true };
    let s = applyEvent(snap(), { type: 'spin.started', seq: 2, roomId: 'r', at: 0, spin: { id: 'x', djUserId: 'd', track, startedAtServerMs: 0, durationMs: 1000, endedAt: null, endReason: null }, upNext: [] });
    expect(s.currentSpin?.id).toBe('x');
    expect(s.me?.vote).toBeNull();
    s = applyEvent(s, { type: 'votes.changed', seq: 3, roomId: 'r', at: 0, spinId: 'x', tally: { hype: 2, skip: 1, eligibleVoters: 4 } });
    expect(s.tally.hype).toBe(2);
    s = applyEvent(s, { type: 'spin.ended', seq: 4, roomId: 'r', at: 0, spinId: 'x', reason: 'completed', hype: 2, skip: 1, eligibleVoters: 4, fadeMs: 0 });
    expect(s.currentSpin).toBeNull();
    expect(s.seq).toBe(4);
  });
  it('tracks my queue membership', () => {
    const s = applyEvent(snap(), { type: 'dj_queue.changed', seq: 2, roomId: 'r', at: 0, queue: [{ userId: 'me', joinedAt: 0, cooldownUntil: null }] }, 'me');
    expect(s.me?.inQueue).toBe(true);
  });
});

describe('SpinroomClient', () => {
  it('builds URLs and surfaces problems', async () => {
    const calls: [string, RequestInit][] = [];
    const c = new SpinroomClient({
      baseUrl: 'https://x.test',
      getToken: () => 'tok',
      surface: 'mcp',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        return new Response(JSON.stringify({ type: 't', title: 'on cooldown', status: 422, code: 'on_cooldown', detail: 'wait' }), { status: 422 });
      }) as unknown as typeof fetch,
    });
    await expect(c.call('djQueue.join', { params: { slug: 'my room' } })).rejects.toMatchObject({ code: 'on_cooldown', status: 422 });
    expect(calls[0]![0]).toBe('https://x.test/v1/rooms/my%20room/dj-queue');
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((calls[0]![1].headers as Record<string, string>)['x-spinroom-surface']).toBe('mcp');
    expect(new ApiError(0, null, 'x').code).toBe('network_error');
    expect(c.url('rooms.list', { query: { filter: 'mine', q: undefined } })).toBe('https://x.test/v1/rooms?filter=mine');
  });
  it('formats times', () => {
    expect(formatMs(102_000)).toBe('1:42');
  });
});

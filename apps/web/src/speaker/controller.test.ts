import { ServerClock } from '@spinroom/sdk';
import type { Spin } from '@spinroom/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeakerController, type SpeakerApi } from './controller';
import { FakePlayer } from './fakePlayer';

const spin = (id: string, startedAtServerMs: number, durationMs = 180_000): Spin => ({
  id,
  djUserId: 'dj',
  track: { uri: `spotify:track:${id}`, title: id, artists: ['a'], album: '', artUrl: null, durationMs, explicit: false, playable: true },
  startedAtServerMs,
  durationMs,
  endedAt: null,
  endReason: null,
});

function setup(opts: { offset?: number; driftPerSec?: number } = {}) {
  const clock = new ServerClock();
  clock.addSample(opts.offset ?? 0);
  const player = new FakePlayer(opts.driftPerSec ?? 0, () => Date.now());
  const beats: Parameters<SpeakerApi['heartbeat']>[1][] = [];
  let superseded = false;
  const api: SpeakerApi = {
    register: vi.fn(async () => ({ id: 'sp1' })),
    heartbeat: vi.fn(async (_id, b) => {
      beats.push(b);
      return { superseded };
    }),
    close: vi.fn(async () => {}),
  };
  const c = new SpeakerController(player, clock, api, {
    deviceName: 'Spinroom — test',
    timers: { setTimeout, clearTimeout, setInterval, clearInterval } as never,
  });
  return { c, player, api, beats, supersede: () => (superseded = true) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => vi.useRealTimers());

describe('SpeakerController', () => {
  it('starts a late joiner at the live position using the server clock offset', async () => {
    // Server is 2 s ahead of us; the spin started 30 s ago in server time.
    const { c, player } = setup({ offset: 2000 });
    await c.setSpin(spin('a', Date.now() + 2000 - 30_000));
    await c.start();
    const st = await player.getState();
    expect(st?.uri).toBe('spotify:track:a');
    expect(st!.positionMs).toBeCloseTo(30_000, -1);
    expect(c.view.status).toBe('live');
  });

  it('waits for a spin that starts after a fade', async () => {
    const { c, player } = setup();
    await c.start();
    await c.setSpin(spin('b', Date.now() + 3000));
    expect((await player.getState())?.uri).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    const st = await player.getState();
    expect(st?.uri).toBe('spotify:track:b');
    expect(st!.positionMs).toBeLessThan(50);
  });

  it('seeks only after drift stays over 1.5 s for two checks', async () => {
    const { c, player } = setup({ driftPerSec: 200 }); // runs 20% fast
    await c.start();
    await c.setSpin(spin('c', Date.now()));
    const seek = vi.spyOn(player, 'seek');
    await vi.advanceTimersByTimeAsync(5000); // still settling after the play: no judgement
    expect(c.view.driftMs).toBeNull();
    await vi.advanceTimersByTimeAsync(5000); // drift ≈ 2 s: first reading over, wait
    expect(seek).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); // drift ≈ 3 s again → seek
    expect(seek).toHaveBeenCalledTimes(1);
    const st = await player.getState();
    expect(Math.abs(st!.positionMs - 15_000)).toBeLessThan(100);
  });

  it('seeks at once when far off, and reloads if it is still far off', async () => {
    const { c, player } = setup();
    await c.start();
    await c.setSpin(spin('d', Date.now()));
    await vi.advanceTimersByTimeAsync(10_000); // past the settle window, in sync
    const play = vi.spyOn(player, 'play');
    const seek = vi.spyOn(player, 'seek');
    await player.seek(60_000);
    seek.mockClear();
    await vi.advanceTimersByTimeAsync(5000); // > 5 s off → seek right away
    expect(seek).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
    await player.seek(60_000);
    await vi.advanceTimersByTimeAsync(10_000); // settle, then > 5 s off again → reload
    expect(play).toHaveBeenCalledWith('spotify:track:d', expect.any(Number));
  });

  it('does not restart the track for a pause that lasts one check', async () => {
    const { c, player } = setup();
    await c.start();
    await c.setSpin(spin('p', Date.now()));
    await vi.advanceTimersByTimeAsync(10_000);
    const play = vi.spyOn(player, 'play');
    await player.pause(); // e.g. Spotify buffering
    await vi.advanceTimersByTimeAsync(5000);
    expect(play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); // still paused on the next check → play again
    expect(play).toHaveBeenCalledWith('spotify:track:p', expect.any(Number));
    expect((await player.getState())!.paused).toBe(false);
  });

  it('pauses when the DJ pauses, stays paused through drift checks, and resumes at the held position', async () => {
    const { c, player } = setup();
    await c.start();
    const started = Date.now();
    await c.setSpin(spin('h', started));
    await vi.advanceTimersByTimeAsync(20_000);
    await c.setSpin({ ...spin('h', started), pausedAtServerMs: Date.now() });
    expect((await player.getState())!.paused).toBe(true);
    const play = vi.spyOn(player, 'play');
    await vi.advanceTimersByTimeAsync(60_000); // many drift checks: no restart while paused
    expect(play).not.toHaveBeenCalled();
    // Resume: the start moves 60 s later, so it picks up ~20 s in.
    await c.setSpin(spin('h', started + 60_000));
    const st = await player.getState();
    expect(st!.paused).toBe(false);
    expect(st!.positionMs).toBeCloseTo(20_000, -2);
  });

  it('a late joiner to a paused spin stays silent until it resumes', async () => {
    const { c, player } = setup();
    await c.setSpin({ ...spin('q', Date.now() - 30_000), pausedAtServerMs: Date.now() - 10_000 });
    await c.start();
    expect((await player.getState())?.uri ?? null).toBeNull();
  });

  it('heartbeats every 15 s with position and audibility', async () => {
    const { c, beats } = setup();
    await c.start();
    await c.setSpin(spin('e', Date.now()));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.at(-1)).toMatchObject({ status: 'live', audible: true, spinId: 'e' });
    await c.setVolume(0.5, true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(beats.at(-1)!.audible).toBe(false);
  });

  it('fades out over 3 s on spin.ended then pauses', async () => {
    const { c, player } = setup();
    await c.start();
    await c.setSpin(spin('f', Date.now() - 10_000));
    await c.endSpin('f', 3000);
    await vi.advanceTimersByTimeAsync(1500);
    expect(player.volume).toBeLessThan(1);
    expect(player.volume).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect((await player.getState())!.paused).toBe(true);
  });

  it('shows "playing elsewhere" and reclaims', async () => {
    const { c, player } = setup();
    await c.start();
    await c.setSpin(spin('g', Date.now() - 1000));
    player.simulateLost();
    expect(c.view).toMatchObject({ status: 'paused_elsewhere', message: 'Paused — Spotify is playing elsewhere' });
    await c.reclaim();
    expect(c.view.status).toBe('live');
    expect((await player.getState())!.paused).toBe(false);
  });

  it('stops when the server says another tab took over', async () => {
    const { c, supersede } = setup();
    await c.start();
    supersede();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(c.view).toMatchObject({ status: 'off', message: 'Your speaker moved to another tab.' });
  });
});

import { describe, expect, it } from 'vitest';
import { buildRecap, djMoment, endMoment, isRecapTime } from '../src/moments.js';

describe('moments', () => {
  it('words a new DJ, a crowd skip and a big hype; stays quiet otherwise', () => {
    expect(djMoment('Pete', { title: 'Neon Tide', artists: ['The Velvet Pixels'] })).toBe(
      '🎧 *Pete* stepped up to the decks with *Neon Tide* — The Velvet Pixels',
    );
    const s = { djUserId: 'u1', title: 'Neon Tide', artists: ['A'], hype: 0, skip: 3 };
    expect(endMoment('auto_skip', s, 'Pete')).toBe('😬 The crowd skipped *Neon Tide* (3 skips)');
    expect(endMoment('completed', { ...s, hype: 4, skip: 1 }, 'Pete')).toBe('🔥 *Neon Tide* got 4 hypes. Nice one, *Pete*!');
    expect(endMoment('completed', { ...s, hype: 2, skip: 0 }, 'Pete')).toBeNull();
    expect(endMoment('completed', { ...s, hype: 4, skip: 3 }, 'Pete')).toBeNull();
  });
});

describe('recap timing', () => {
  // Friday 10 October 2025, 20:30 UTC = 16:30 in New York (EDT).
  const fri = Date.UTC(2025, 9, 10, 20, 30);
  it('is due on Friday from 4 pm in the channel’s time zone', () => {
    expect(isRecapTime(fri, 'America/New_York', null)).toBe(true);
    expect(isRecapTime(fri - 60 * 60_000, 'America/New_York', null)).toBe(false); // 15:30 there
    expect(isRecapTime(fri, 'Asia/Tokyo', null)).toBe(false); // already Saturday there
    expect(isRecapTime(Date.UTC(2025, 9, 10, 16, 5), null, null)).toBe(true); // UTC by default
    expect(isRecapTime(fri, 'Not/AZone', null)).toBe(true); // bad zone falls back to UTC
  });
  it('posts at most once in five days', () => {
    expect(isRecapTime(fri, 'America/New_York', fri - 2 * 3600_000)).toBe(false);
    expect(isRecapTime(fri, 'America/New_York', fri - 7 * 86_400_000)).toBe(true);
  });
});

describe('recap', () => {
  it('names the DJ of the week and the most-hyped songs; nothing when nothing played', () => {
    const names = new Map([
      ['a', 'Alice'],
      ['b', 'Bob'],
    ]);
    const r = buildRecap(
      'Team Radio',
      [
        { djUserId: 'a', title: 'One', artists: ['X'], hype: 2, skip: 0 },
        { djUserId: 'b', title: 'Two', artists: ['Y'], hype: 5, skip: 1 },
        { djUserId: 'b', title: 'Three', artists: ['Z'], hype: 0, skip: 2 },
      ],
      names,
      'https://example.test/r/team',
    )!;
    const body = JSON.stringify(r.blocks);
    expect(body).toContain('This week in Team Radio');
    expect(body).toContain('*3* songs from *2* DJs');
    expect(body).toContain('DJ of the week: *Bob* — 5 hypes over 2 songs');
    expect(body.indexOf('Two')).toBeLessThan(body.indexOf('One'));
    expect(body).not.toContain('Three');
    expect(body).toContain('https://example.test/r/team');
    expect(buildRecap('Team Radio', [], names, '')).toBeNull();
  });
});

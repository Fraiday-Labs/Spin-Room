import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM_SETTINGS, RoomEventSchema, buildPath, routes, toFastifyPath } from './index.js';

describe('contracts', () => {
  it('has the PRD defaults', () => {
    expect(DEFAULT_ROOM_SETTINGS.boothSlots).toBe(3);
    expect(DEFAULT_ROOM_SETTINGS.skipRatio).toBe(0.5);
    expect(DEFAULT_ROOM_SETTINGS.minSkips).toBe(2);
    expect(DEFAULT_ROOM_SETTINGS.bounceAfter).toBe(2);
    expect(DEFAULT_ROOM_SETTINGS.bounceCooldownMs).toBe(300_000);
    expect(DEFAULT_ROOM_SETTINGS.maxTrackMs).toBe(600_000);
    expect(DEFAULT_ROOM_SETTINGS.turnLimit).toBeNull();
  });

  it('route paths are unique per method', () => {
    const seen = new Set<string>();
    for (const r of Object.values(routes)) {
      const key = `${r.method} ${toFastifyPath(r.path)}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('builds paths', () => {
    expect(buildPath('/v1/rooms/{slug}/crate/{itemId}', { slug: 'a b', itemId: 'x' })).toBe('/v1/rooms/a%20b/crate/x');
  });

  it('parses query booleans without Boolean("false") surprises', () => {
    const q = routes['avatars.create'].query;
    expect(q.parse({ dryRun: 'false', rightsConfirmed: 'true' })).toMatchObject({ dryRun: false, rightsConfirmed: true });
    expect(q.parse({})).toMatchObject({ dryRun: false, rightsConfirmed: false });
  });

  it('validates events', () => {
    const ok = RoomEventSchema.safeParse({ type: 'dj.bounced', seq: 1, roomId: 'r', at: 1, userId: 'u', cooldownUntil: 5 });
    expect(ok.success).toBe(true);
  });
});

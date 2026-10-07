import { PRESET_AVATARS } from '@spinroom/contracts';
import type { Db } from './client.js';
import { avatars } from './schema.js';

/** Preset avatar rows in runtime-sheet order; art is built by tools/art. */
export const PRESET_ROWS = [
  { state: 'idle', frames: 4 },
  { state: 'hype', frames: 4 },
  { state: 'skip', frames: 4 },
  { state: 'dj', frames: 4 },
  { state: 'walk', frames: 4 },
  { state: 'wave', frames: 4 },
  { state: 'away', frames: 2 },
] as const;

export function presetUrls(id: string) {
  const slug = id.replace(/^preset-/, '');
  return { sheetUrl: `/art/avatars/${slug}.webp`, thumbUrl: `/art/avatars/${slug}-thumb.png` };
}

export async function seedPresetAvatars(db: Db): Promise<void> {
  const rows = PRESET_AVATARS.map((p) => ({
    id: p.id,
    ownerId: null,
    name: p.name,
    kind: 'preset' as const,
    sourceFormat: 'preset' as const,
    ...presetUrls(p.id),
    frameCounts: Object.fromEntries(PRESET_ROWS.map((r) => [r.state, r.frames])),
    rows: PRESET_ROWS.map((r) => ({ ...r })),
    status: 'approved' as const,
    createdAt: 0,
  }));
  for (const row of rows) {
    await db
      .insert(avatars)
      .values(row)
      .onConflictDoUpdate({
        target: avatars.id,
        set: { name: row.name, sheetUrl: row.sheetUrl, thumbUrl: row.thumbUrl, rows: row.rows, frameCounts: row.frameCounts },
      });
  }
}

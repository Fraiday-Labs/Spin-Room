import { SpinroomError } from '@spinroom/contracts';
import { and, eq, isNotNull, lt, ne } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { avatars, blobs, users } from '../db/schema.js';
import { sha256 } from '../lib/crypto.js';
import type { AvatarRow } from '../services/users.js';
import { AvatarImportError, buildRuntimeSheet, readSpriteKit, sniff, type BuiltSheet } from './pipeline.js';

/**
 * Bump when the sheet builder changes how uploads look, so avatars saved earlier are rebuilt
 * from their originals at the next boot. 2: neighbouring frames' scraps are cleared.
 * 3: odd-sized sheets are cut along the gaps in the art. 4: each figure is found on its own.
 */
export const AVATAR_BUILD = 4;

export async function putBlob(ctx: AppContext, data: Buffer, prefix: string, ext: string, contentType: string): Promise<{ key: string; sha: string }> {
  const sha = sha256(data);
  const key = `avatars/${prefix}/${sha}.${ext}`;
  const existing = await ctx.db.query.blobs.findFirst({ where: eq(blobs.sha256, `${prefix}:${sha}`) });
  if (!existing || !(await ctx.storage.exists(key))) {
    await ctx.storage.put(key, data, contentType);
    await ctx.db
      .insert(blobs)
      .values({ sha256: `${prefix}:${sha}`, key, contentType, bytes: data.length, createdAt: ctx.clock.now() })
      .onConflictDoNothing();
  }
  return { key, sha };
}

/**
 * Rebuild an uploaded avatar's runtime sheet from its stored original with the owner's view
 * picks. The art is the same upload that was already reviewed, so the review status stays.
 */
export async function rebuild(ctx: AppContext, a: AvatarRow, picks: Record<string, number>): Promise<AvatarRow> {
  const original = await ctx.storage.get(a.originalKey!);
  if (!original) throw new SpinroomError('not_found', 'The original upload for this avatar is missing — upload it again.');
  let built: BuiltSheet;
  try {
    const sheet = sniff(original) === 'zip' ? readSpriteKit(original).sheet : original;
    built = await buildRuntimeSheet(sheet, a.grid ?? undefined, picks);
  } catch (e) {
    if (e instanceof AvatarImportError) throw new SpinroomError('bad_request', e.message);
    throw e;
  }
  const sheetBlob = await putBlob(ctx, built.sheet, 'sheet', 'webp', 'image/webp');
  const thumbBlob = await putBlob(ctx, built.thumb, 'thumb', 'png', 'image/png');
  const viewsBlob = await putBlob(ctx, built.viewsSheet, 'views', 'webp', 'image/webp');
  const [row] = await ctx.db
    .update(avatars)
    .set({
      sheetUrl: sheetBlob.key,
      thumbUrl: thumbBlob.key,
      rows: built.rows,
      frameCounts: built.frameCounts,
      views: built.views,
      viewsUrl: viewsBlob.key,
      choices: built.choices,
      build: AVATAR_BUILD,
    })
    .where(eq(avatars.id, a.id))
    .returning();
  // Everyone wearing it sees the new views right away.
  ctx.services.users.invalidateAvatar(a.id);
  const wearing = await ctx.db.select({ id: users.id }).from(users).where(eq(users.avatarId, a.id));
  for (const u of wearing) await ctx.services.rooms.onProfileChanged(u.id);
  return row!;
}

/** Rebuild uploads made by an older sheet builder (keeps each owner's view picks). */
export async function refreshAvatars(ctx: AppContext, log: (msg: string, err?: unknown) => void = () => {}): Promise<number> {
  const stale = await ctx.db
    .select()
    .from(avatars)
    .where(and(eq(avatars.kind, 'custom'), ne(avatars.status, 'removed'), isNotNull(avatars.originalKey), lt(avatars.build, AVATAR_BUILD)));
  let done = 0;
  for (const a of stale) {
    try {
      await rebuild(ctx, a, a.choices ?? {});
      done++;
    } catch (e) {
      log(`avatar ${a.id} could not be rebuilt`, e);
    }
  }
  return done;
}

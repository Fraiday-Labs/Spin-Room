import { AVATAR_LIMITS, DEFAULT_PRESET_ID, SpinroomError, type AvatarImportReport } from '@spinroom/contracts';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { MultipartFile } from '@fastify/multipart';
import type { AppContext } from '../context.js';
import { avatarReports, avatars, blobs, users } from '../db/schema.js';
import { requireUser, type Handlers } from '../http/router.js';
import { sha256 } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { AvatarImportError, buildRuntimeSheet, parsePetJson, readSpriteKit, sanitizeName, sniff, type PetMeta } from '../avatars/pipeline.js';
import { autoApprove, manualReview } from '../avatars/safety.js';
import { avatarFull } from '../services/users.js';
import { roomBySlug } from '../rooms/access.js';

/** Users with this many confirmed violations lose upload access (FR-A16). */
const MAX_VIOLATIONS = 3;

async function putBlob(ctx: AppContext, data: Buffer, prefix: string, ext: string, contentType: string): Promise<{ key: string; sha: string }> {
  const sha = sha256(data);
  const key = `avatars/${prefix}/${sha}.${ext}`;
  const existing = await ctx.db.query.blobs.findFirst({ where: eq(blobs.sha256, `${prefix}:${sha}`) });
  if (!existing || !(await ctx.storage.exists(key))) {
    await ctx.storage.put(key, data, contentType);
    await ctx.db.insert(blobs).values({ sha256: `${prefix}:${sha}`, key, contentType, bytes: data.length, createdAt: ctx.clock.now() }).onConflictDoNothing();
  }
  return { key, sha };
}

async function readParts(files: AsyncIterableIterator<MultipartFile>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const part of files) {
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new SpinroomError('payload_too_large', 'Uploads are limited to 10 MB');
    out.push(buf);
  }
  return out;
}

const emptyReport = (issues: AvatarImportReport['issues']): AvatarImportReport => ({
  ok: false,
  avatar: null,
  sourceFormat: null,
  detectedSize: null,
  needsGrid: null,
  frameCounts: null,
  suggestedName: null,
  preview: null,
  issues,
});

export const avatarHandlers: Handlers = {
  'avatars.create': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, query, req } = c;
    const user = await ctx.services.users.get(userId);
    if (user?.uploadRevoked) throw new SpinroomError('upload_revoked', 'Avatar uploads are turned off for your account after repeated violations.');
    if (!req.isMultipart()) throw new SpinroomError('bad_request', 'Send the file as multipart/form-data');
    const parts = await readParts(req.files());
    if (!parts.length) throw new SpinroomError('bad_request', 'No file uploaded');

    // Accept: sprite kit zip | single sheet | pet.json + sheet (pet folder files).
    let sheet: Buffer;
    let original: Buffer;
    let pet: PetMeta | null = null;
    try {
      const kinds = parts.map(sniff);
      if (parts.length === 1 && kinds[0] === 'zip') {
        const kit = readSpriteKit(parts[0]!);
        pet = parsePetJson(kit.petJson);
        sheet = kit.sheet;
        original = parts[0]!;
      } else if (parts.length === 1 && (kinds[0] === 'png' || kinds[0] === 'webp')) {
        sheet = parts[0]!;
        original = sheet;
      } else if (parts.length === 2 && kinds.includes('json')) {
        const ji = kinds.indexOf('json');
        pet = parsePetJson(parts[ji]!);
        sheet = parts[1 - ji]!;
        original = sheet;
      } else {
        throw new AvatarImportError('format_unsupported', 'Upload the .codex-pet.zip from Download sprite kit, a single PNG/WebP sheet, or pet.json together with its sprite sheet.');
      }
      const built = await buildRuntimeSheet(sheet, { ...(query.cols ? { cols: query.cols } : {}), ...(query.rows ? { rows: query.rows } : {}) });
      const sourceFormat = pet ? (built.layout.version === 2 || pet.version === 2 ? 'pet_v2' : 'pet_v1') : 'single_sheet';
      const sheetBlob = await putBlob(ctx, built.sheet, 'sheet', 'webp', 'image/webp');
      const thumbBlob = await putBlob(ctx, built.thumb, 'thumb', 'png', 'image/png');
      const name = sanitizeName(query.name ?? pet?.name ?? '') || 'My pet';
      const previewRef = {
        id: `preview-${sheetBlob.sha.slice(0, 12)}`,
        kind: 'custom' as const,
        name,
        sheetUrl: ctx.storage.url(sheetBlob.key),
        thumbUrl: ctx.storage.url(thumbBlob.key),
        rows: built.rows,
        cell: { w: 96, h: 104 },
      };
      const report: AvatarImportReport = {
        ok: true,
        avatar: null,
        sourceFormat,
        detectedSize: built.size,
        needsGrid: null,
        frameCounts: built.frameCounts,
        suggestedName: pet?.name ?? null,
        preview: previewRef,
        issues: built.issues,
      };
      if (query.dryRun) return report;

      // FR-A12: rights confirmation is required to save.
      if (!query.rightsConfirmed) throw new SpinroomError('rights_not_confirmed', 'Confirm you have the right to use this art and that it isn’t a copyrighted or trademarked character.');
      const mine = await ctx.db.select({ id: avatars.id }).from(avatars).where(and(eq(avatars.ownerId, userId), ne(avatars.status, 'removed')));
      if (mine.length >= AVATAR_LIMITS.customPerUser) throw new SpinroomError('avatar_limit', `You can keep up to ${AVATAR_LIMITS.customPerUser} custom avatars — delete one first.`);
      const orig = await putBlob(ctx, original, 'orig', sniff(original) === 'zip' ? 'zip' : sniff(original), sniff(original) === 'zip' ? 'application/zip' : `image/${sniff(original)}`);
      const id = newId();
      const provider = ctx.cfg.AVATAR_SAFETY === 'auto_approve' ? autoApprove : manualReview;
      const status = await provider.check(built.sheet, { avatarId: id, ownerId: userId });
      const [row] = await ctx.db
        .insert(avatars)
        .values({
          id,
          ownerId: userId,
          name,
          kind: 'custom',
          sourceFormat,
          originalUrl: ctx.storage.url(orig.key),
          originalKey: orig.key,
          sheetUrl: sheetBlob.key,
          thumbUrl: thumbBlob.key,
          sha256: orig.sha,
          frameCounts: built.frameCounts,
          rows: built.rows,
          grid: built.layout.version ? null : { cols: built.layout.cols, rows: built.layout.rows },
          petJson: pet ? { name: pet.name, spritesheet: pet.spritesheet, spriteVersionNumber: pet.version } : null,
          status: status === 'rejected' ? 'rejected' : status,
          createdAt: ctx.clock.now(),
        })
        .returning();
      ctx.services.analytics.track('avatar_imported', { userId, props: { sourceFormat, status } });
      return { ...report, avatar: avatarFull(ctx, row!) };
    } catch (e) {
      if (e instanceof AvatarImportError) {
        return {
          ...emptyReport([{ level: 'error', code: e.issueCode, message: e.message }]),
          needsGrid: e.extra.needsGrid ?? null,
          detectedSize: e.extra.detectedSize ?? null,
          suggestedName: pet?.name ?? null,
        };
      }
      throw e;
    }
  },

  'avatars.presets': async ({ ctx }) => {
    const rows = await ctx.db.select().from(avatars).where(eq(avatars.kind, 'preset')).orderBy(asc(avatars.id));
    return rows.map((r) => avatarFull(ctx, r));
  },

  'avatars.mine': async (c) => {
    const { userId } = requireUser(c);
    const rows = await c.ctx.db.select().from(avatars).where(and(eq(avatars.ownerId, userId), ne(avatars.status, 'removed'))).orderBy(asc(avatars.createdAt));
    return rows.map((r) => avatarFull(c.ctx, r));
  },

  'avatars.get': async ({ ctx, params, auth }) => {
    const a = await ctx.db.query.avatars.findFirst({ where: eq(avatars.id, params.id) });
    const viewer = auth ? await ctx.services.users.get(auth.userId) : null;
    if (!a || (a.status !== 'approved' && a.ownerId !== auth?.userId && !viewer?.isAdmin)) throw new SpinroomError('not_found', 'Avatar not found');
    return avatarFull(ctx, a);
  },

  'avatars.delete': async (c) => {
    const { userId } = requireUser(c);
    const { ctx } = c;
    const a = await ctx.db.query.avatars.findFirst({ where: eq(avatars.id, c.params.id) });
    if (!a || a.ownerId !== userId) throw new SpinroomError('not_found', 'Avatar not found');
    await ctx.db.update(avatars).set({ status: 'removed' }).where(eq(avatars.id, a.id));
    await revertUsers(ctx, a.id);
    return { ok: true as const };
  },

  'avatars.report': async (c) => {
    const { userId } = requireUser(c);
    const { ctx, body } = c;
    const a = await ctx.db.query.avatars.findFirst({ where: eq(avatars.id, c.params.id) });
    if (!a || a.kind !== 'custom') throw new SpinroomError('not_found', 'Avatar not found');
    const room = body.roomSlug ? await roomBySlug(ctx, body.roomSlug).catch(() => null) : null;
    await ctx.db.insert(avatarReports).values({ id: newId(), avatarId: a.id, reporterId: userId, roomId: room?.id ?? null, reason: body.reason, createdAt: ctx.clock.now() });
    return { ok: true as const };
  },

  'admin.avatarQueue': async ({ ctx }) => {
    const pending = await ctx.db.select().from(avatars).where(eq(avatars.status, 'pending')).orderBy(asc(avatars.createdAt));
    const reports = await ctx.db.select().from(avatarReports).where(isNull(avatarReports.resolvedAt)).orderBy(asc(avatarReports.createdAt));
    const reported = reports.length ? await ctx.db.select().from(avatars).where(inArray(avatars.id, [...new Set(reports.map((r) => r.avatarId))])) : [];
    const byId = new Map(reported.map((a) => [a.id, a]));
    return {
      pending: pending.map((a) => avatarFull(ctx, a)),
      reports: reports
        .filter((r) => byId.has(r.avatarId))
        .map((r) => ({
          id: r.id,
          avatarId: r.avatarId,
          reporterId: r.reporterId,
          roomId: r.roomId,
          reason: r.reason,
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
          resolution: r.resolution,
          avatar: avatarFull(ctx, byId.get(r.avatarId)!),
        })),
    };
  },

  'admin.reviewAvatar': async (c) => {
    const { ctx, body } = c;
    const a = await ctx.db.query.avatars.findFirst({ where: eq(avatars.id, c.params.id) });
    if (!a || a.kind !== 'custom') throw new SpinroomError('not_found', 'Avatar not found');
    const status = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : 'removed';
    const [row] = await ctx.db.update(avatars).set({ status }).where(eq(avatars.id, a.id)).returning();
    const now = ctx.clock.now();
    await ctx.db
      .update(avatarReports)
      .set({ resolvedAt: now, resolution: `${body.decision}${body.note ? `: ${body.note}` : ''}` })
      .where(and(eq(avatarReports.avatarId, a.id), isNull(avatarReports.resolvedAt)));
    ctx.services.users.invalidateAvatar(a.id);
    if (status !== 'approved') {
      await revertUsers(ctx, a.id);
      if (a.ownerId) {
        const owner = await ctx.services.users.get(a.ownerId);
        if (owner) {
          const violations = owner.violationCount + 1;
          await ctx.db.update(users).set({ violationCount: violations, uploadRevoked: owner.uploadRevoked || violations >= MAX_VIOLATIONS }).where(eq(users.id, owner.id));
        }
      }
    } else if (a.ownerId) {
      await ctx.services.rooms.onProfileChanged(a.ownerId);
    }
    return avatarFull(ctx, row!);
  },
};

/** Anyone using a removed/rejected avatar falls back to their preset everywhere. */
async function revertUsers(ctx: AppContext, avatarId: string) {
  const using = await ctx.db.select().from(users).where(eq(users.avatarId, avatarId));
  for (const u of using) {
    await ctx.db.update(users).set({ avatarId: u.presetAvatarId || DEFAULT_PRESET_ID }).where(eq(users.id, u.id));
    await ctx.services.rooms.onProfileChanged(u.id);
  }
  ctx.services.users.invalidateAvatar(avatarId);
}


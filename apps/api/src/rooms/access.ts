import { DEFAULT_ROOM_SETTINGS, RoomSettingsSchema, SpinroomError, type Role, type Room } from '@spinroom/contracts';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { roomMembers, rooms } from '../db/schema.js';

export type RoomRow = typeof rooms.$inferSelect;
export type MemberRow = typeof roomMembers.$inferSelect;

export function roomSettings(row: RoomRow) {
  return RoomSettingsSchema.parse({ ...DEFAULT_ROOM_SETTINGS, ...row.settingsJson });
}

export function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    ownerId: row.ownerId,
    settings: roomSettings(row),
    createdAt: row.createdAt,
    closedAt: row.closedAt ?? null,
    linkSharing: !!row.shareToken,
  };
}

export async function roomBySlug(ctx: AppContext, slug: string): Promise<RoomRow> {
  const row = await ctx.db.query.rooms.findFirst({ where: eq(rooms.slug, slug.toLowerCase()) });
  if (!row) throw new SpinroomError('room_not_found', `No room called “${slug}”`);
  return row;
}

export async function memberRow(ctx: AppContext, roomId: string, userId: string): Promise<MemberRow | null> {
  return (await ctx.db.query.roomMembers.findFirst({ where: and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)) })) ?? null;
}

/** Can this user see the room at all? Public rooms: anyone not banned; invite-only: members. */
export async function assertCanView(ctx: AppContext, room: RoomRow, userId: string | null): Promise<MemberRow | null> {
  // Closed rooms are shut for everyone, owner included (they reopen it from the lobby first).
  if (room.closedAt) throw new SpinroomError('room_closed', 'This room was closed by its owner');
  const m = userId ? await memberRow(ctx, room.id, userId) : null;
  if (m?.banned) throw new SpinroomError('banned', 'You were banned from this room');
  if (room.visibility === 'invite_only' && !m) throw new SpinroomError('not_member', 'This room is invite-only — ask for an invite link');
  return m;
}

/** Member (creating the membership for public rooms on first use). */
export async function ensureMember(ctx: AppContext, room: RoomRow, userId: string): Promise<MemberRow> {
  const m = await assertCanView(ctx, room, userId);
  if (m) return m;
  const [row] = await ctx.db
    .insert(roomMembers)
    .values({ roomId: room.id, userId, role: room.ownerId === userId ? 'owner' : 'member', joinedAt: ctx.clock.now() })
    .onConflictDoNothing()
    .returning();
  return row ?? (await memberRow(ctx, room.id, userId))!;
}

export function isMod(role: Role | null | undefined) {
  return role === 'owner' || role === 'moderator';
}

/** Site admins (ADMIN_SPOTIFY_IDS) can manage any room, e.g. to clean up rooms whose owner is gone. */
export async function isSiteAdmin(ctx: AppContext, userId: string): Promise<boolean> {
  return !!(await ctx.services.users.get(userId))?.isAdmin;
}

export async function assertMod(ctx: AppContext, room: RoomRow, userId: string): Promise<MemberRow> {
  const m = await memberRow(ctx, room.id, userId);
  if (m && isMod(m.role)) return m;
  if (await isSiteAdmin(ctx, userId)) {
    // Act with owner powers; make sure there's a membership row to act from.
    await ctx.db.insert(roomMembers).values({ roomId: room.id, userId, role: 'member', joinedAt: ctx.clock.now() }).onConflictDoNothing();
    return { ...(m ?? (await memberRow(ctx, room.id, userId))!), role: 'owner' };
  }
  throw new SpinroomError('forbidden', 'Only the room owner and moderators can do that');
}

/** Close, reopen and delete are the owner's alone (and site admins'). */
export async function assertOwner(ctx: AppContext, room: RoomRow, userId: string) {
  if (room.ownerId === userId || (await isSiteAdmin(ctx, userId))) return;
  throw new SpinroomError('forbidden', 'Only the room owner can close, reopen or delete it');
}

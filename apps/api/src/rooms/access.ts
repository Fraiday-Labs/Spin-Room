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

export async function assertMod(ctx: AppContext, room: RoomRow, userId: string): Promise<MemberRow> {
  const m = await memberRow(ctx, room.id, userId);
  if (!m || !isMod(m.role)) throw new SpinroomError('forbidden', 'Only the room owner and moderators can do that');
  return m;
}

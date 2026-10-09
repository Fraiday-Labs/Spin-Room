import { z } from 'zod';
import {
  AvatarRefSchema,
  BoothSlotSchema,
  ChatMessageSchema,
  EndReasonSchema,
  IdSchema,
  PresenceStateSchema,
  QueueEntrySchema,
  RoomSnapshotSchema,
  RoomStatusSchema,
  SpinSchema,
  TallySchema,
  TimestampSchema,
  UpNextItemSchema,
  MemberSchema,
} from './models.js';
import { RoomSettingsSchema } from './settings.js';

const base = { seq: z.number().int().nonnegative(), roomId: IdSchema, at: TimestampSchema };

export const RoomEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('room.snapshot'), snapshot: RoomSnapshotSchema }),
  z.object({
    ...base,
    type: z.literal('presence.changed'),
    userId: IdSchema,
    state: PresenceStateSchema,
    eligible: z.boolean(),
    /** Present when the member joined or switched avatars (FR-A17/A18). */
    member: MemberSchema.optional(),
    avatar: AvatarRefSchema.optional(),
    left: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal('booth.changed'), booth: z.array(BoothSlotSchema), activeSlot: z.number().int().nullable() }),
  z.object({ ...base, type: z.literal('dj_queue.changed'), queue: z.array(QueueEntrySchema) }),
  z.object({ ...base, type: z.literal('spin.started'), spin: SpinSchema, upNext: z.array(UpNextItemSchema) }),
  z.object({
    ...base,
    type: z.literal('spin.ended'),
    spinId: IdSchema,
    reason: EndReasonSchema,
    hype: z.number().int(),
    skip: z.number().int(),
    eligibleVoters: z.number().int(),
    /** Speakers fade over this many ms. */
    fadeMs: z.number().int(),
  }),
  /** The DJ paused or resumed the current spin. On resume the start moves later by the time spent paused. */
  z.object({
    ...base,
    type: z.literal('spin.playback'),
    spinId: IdSchema,
    startedAtServerMs: TimestampSchema,
    pausedAtServerMs: TimestampSchema.nullable(),
  }),
  z.object({ ...base, type: z.literal('votes.changed'), spinId: IdSchema, tally: TallySchema }),
  z.object({ ...base, type: z.literal('dj.bounced'), userId: IdSchema, cooldownUntil: TimestampSchema }),
  z.object({ ...base, type: z.literal('chat.message'), message: ChatMessageSchema }),
  z.object({ ...base, type: z.literal('chat.reaction'), messageId: IdSchema, reactions: z.record(z.string(), z.array(IdSchema)) }),
  z.object({ ...base, type: z.literal('room.settings_changed'), settings: RoomSettingsSchema, name: z.string(), description: z.string() }),
  z.object({ ...base, type: z.literal('room.status_changed'), status: RoomStatusSchema }),
  /** The owner closed or deleted the room: playback stops and every socket is closed after this. */
  z.object({ ...base, type: z.literal('room.closed'), reason: z.enum(['closed', 'deleted']) }),
  z.object({ ...base, type: z.literal('up_next.changed'), upNext: z.array(UpNextItemSchema) }),
  /** A notice aimed at one member (FR-L4 up next, FR-L5 crate ran out, FR-C3 unplayable). */
  z.object({
    ...base,
    type: z.literal('user.notice'),
    userId: IdSchema,
    kind: z.enum(['up_next', 'crate_ran_out', 'track_skipped_unplayable', 'bounced', 'kicked', 'turn_over', 'removed_from_booth', 'speaker_moved']),
    message: z.string(),
  }),
]);
export type RoomEvent = z.infer<typeof RoomEventSchema>;
export type RoomEventType = RoomEvent['type'];
export type RoomEventOf<T extends RoomEventType> = Extract<RoomEvent, { type: T }>;
/** An event before the publisher stamps `seq`, `roomId` and `at`. */
export type RoomEventBody = RoomEvent extends infer E ? (E extends RoomEvent ? Omit<E, 'seq' | 'roomId' | 'at'> : never) : never;

/** Messages a client may send on the live socket. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resync') }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pong'), t: z.number(), serverNow: TimestampSchema }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerControl = z.infer<typeof ServerControlSchema>;

/** Internal pub/sub channel names shared by the API, Slack and MCP services. */
export const channels = {
  room: (roomId: string) => `events:room:${roomId}`,
  roomPattern: 'events:room:*',
};

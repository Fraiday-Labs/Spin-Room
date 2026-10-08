import { z } from 'zod';
import { RoomSettingsSchema } from './settings.js';

export const IdSchema = z.string().min(1).max(64);
export const TimestampSchema = z.number().int().nonnegative();

export const SurfaceSchema = z.enum(['web', 'slack', 'mcp']);
export type Surface = z.infer<typeof SurfaceSchema>;

export const VisibilitySchema = z.enum(['public', 'invite_only']);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const RoleSchema = z.enum(['owner', 'moderator', 'member']);
export type Role = z.infer<typeof RoleSchema>;

/** FR-P2. */
export const PresenceStateSchema = z.enum(['speaker', 'remote', 'away']);
export type PresenceState = z.infer<typeof PresenceStateSchema>;

export const VoteValueSchema = z.enum(['hype', 'skip']);
export type VoteValue = z.infer<typeof VoteValueSchema>;

export const EndReasonSchema = z.enum(['completed', 'auto_skip', 'dj_skip', 'mod_skip', 'dj_left', 'room_closed']);
export type EndReason = z.infer<typeof EndReasonSchema>;

export const RoomStatusSchema = z.enum(['idle', 'playing', 'paused']);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const TrackSchema = z.object({
  uri: z.string().regex(/^spotify:track:[A-Za-z0-9]+$/),
  title: z.string(),
  artists: z.array(z.string()),
  album: z.string().default(''),
  artUrl: z.string().nullable(),
  durationMs: z.number().int().positive(),
  explicit: z.boolean().default(false),
  playable: z.boolean().default(true),
});
export type Track = z.infer<typeof TrackSchema>;

export const AvatarKindSchema = z.enum(['preset', 'custom']);
export const AvatarStatusSchema = z.enum(['pending', 'approved', 'rejected', 'removed']);
export const AvatarSourceFormatSchema = z.enum(['preset', 'pet_v1', 'pet_v2', 'single_sheet']);

/** Spinroom avatar states and the per-state frame counts in the runtime sheet. */
export const AvatarStateSchema = z.enum(['idle', 'hype', 'skip', 'dj', 'booth', 'walk', 'wave', 'away']);
export type AvatarState = z.infer<typeof AvatarStateSchema>;

export const AvatarRefSchema = z.object({
  id: IdSchema,
  kind: AvatarKindSchema,
  name: z.string(),
  sheetUrl: z.string(),
  thumbUrl: z.string(),
  /**
   * One entry per state, with frame counts. `at` is the sheet row the state plays; when absent
   * it is the entry's own index. States can share a sheet row (e.g. floor and booth).
   */
  rows: z.array(
    z.object({ state: AvatarStateSchema, frames: z.number().int().min(0), dimmed: z.boolean().optional(), at: z.number().int().min(0).optional() }),
  ),
  cell: z.object({ w: z.number().int(), h: z.number().int() }),
});
export type AvatarRef = z.infer<typeof AvatarRefSchema>;

export const AvatarSchema = AvatarRefSchema.extend({
  ownerId: IdSchema.nullable(),
  /** A site admin's upload offered to everyone as a default. */
  featured: z.boolean(),
  status: AvatarStatusSchema,
  sourceFormat: AvatarSourceFormatSchema,
  createdAt: TimestampSchema,
});
export type Avatar = z.infer<typeof AvatarSchema>;

/** The states an owner can point at any view (row) of their uploaded sheet. */
export const AVATAR_VIEW_STATES = ['idle', 'booth', 'dj', 'hype', 'skip', 'wave'] as const;
export const AvatarViewChoicesSchema = z.object(
  Object.fromEntries(AVATAR_VIEW_STATES.map((s) => [s, z.number().int().min(0).max(63).optional()])) as Record<
    (typeof AVATAR_VIEW_STATES)[number],
    z.ZodOptional<z.ZodNumber>
  >,
);
export type AvatarViewChoices = z.infer<typeof AvatarViewChoicesSchema>;

/** Every non-empty row of an uploaded sheet, for picking which one plays where. */
export const AvatarViewsSchema = z.object({
  /** Sheet with one row per view, `cell`-sized frames, in `views` order. */
  sheetUrl: z.string(),
  cell: z.object({ w: z.number().int(), h: z.number().int() }),
  views: z.array(z.object({ row: z.number().int(), name: z.string(), frames: z.number().int() })),
  /** The source row each state plays (the defaults filled in). */
  choices: z.record(z.string(), z.number().int()),
  avatar: AvatarSchema,
});
export type AvatarViews = z.infer<typeof AvatarViewsSchema>;

export const PublicUserSchema = z.object({
  id: IdSchema,
  displayName: z.string(),
  avatar: AvatarRefSchema,
  avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  points: z.number().int().nonnegative(),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

export const MeSchema = PublicUserSchema.extend({
  spotifyUserId: z.string(),
  spotifyClientId: z.string().nullable(),
  email: z.string().nullable(),
  isPremium: z.boolean(),
  /** Free accounts can browse and chat but not run a speaker or DJ. */
  remoteOnly: z.boolean(),
  isAdmin: z.boolean(),
  /** Uploaded profile photo; null shows the initial-letter circle. */
  photoUrl: z.string().nullable(),
  uploadRevoked: z.boolean(),
  connections: z.object({ slack: z.boolean(), mcp: z.boolean() }),
  createdAt: TimestampSchema,
});
export type Me = z.infer<typeof MeSchema>;

export const RoomSchema = z.object({
  id: IdSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  visibility: VisibilitySchema,
  ownerId: IdSchema,
  settings: RoomSettingsSchema,
  createdAt: TimestampSchema,
  /** Set while the owner has closed the room (hidden, no one can join; reopenable). */
  closedAt: TimestampSchema.nullable(),
  /** Invite-only rooms: "Anyone with the link" can join (the link itself comes from rooms.shareLink). */
  linkSharing: z.boolean(),
});
export type Room = z.infer<typeof RoomSchema>;

export const ShareLinkSchema = z.object({
  /** The link to share: public rooms and link-shared rooms let anyone in; otherwise it works for members only. */
  url: z.string(),
  linkSharing: z.boolean(),
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

export const RoomSummarySchema = RoomSchema.pick({
  id: true,
  slug: true,
  name: true,
  description: true,
  visibility: true,
  ownerId: true,
  closedAt: true,
}).extend({
  listeners: z.number().int().nonnegative(),
  liveSpeakers: z.number().int().nonnegative(),
  status: RoomStatusSchema,
  nowPlaying: z.object({ title: z.string(), artists: z.array(z.string()), djName: z.string() }).nullable(),
  myRole: RoleSchema.nullable(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

export const MemberSchema = z.object({
  user: PublicUserSchema,
  role: RoleSchema,
  presence: PresenceStateSchema,
  /** Speaker live, or heard audio recently (FR-V2). */
  eligible: z.boolean(),
  /** Custom avatar hidden by a room moderator (FR-A15). */
  avatarHidden: z.boolean(),
  muted: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;

export const BoothSlotSchema = z.object({
  slot: z.number().int().min(0).max(2),
  userId: IdSchema.nullable(),
  spinsThisTurn: z.number().int().nonnegative(),
  consecutiveSkips: z.number().int().nonnegative(),
});
export type BoothSlot = z.infer<typeof BoothSlotSchema>;

export const QueueEntrySchema = z.object({
  userId: IdSchema,
  joinedAt: TimestampSchema,
  cooldownUntil: TimestampSchema.nullable(),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

export const TallySchema = z.object({
  hype: z.number().int().nonnegative(),
  skip: z.number().int().nonnegative(),
  eligibleVoters: z.number().int().nonnegative(),
});
export type Tally = z.infer<typeof TallySchema>;

export const SpinSchema = z.object({
  id: IdSchema,
  djUserId: IdSchema,
  track: TrackSchema,
  /** Server-authoritative start (may be slightly in the future after a fade). */
  startedAtServerMs: TimestampSchema,
  durationMs: z.number().int().positive(),
  endedAt: TimestampSchema.nullable(),
  endReason: EndReasonSchema.nullable(),
});
export type Spin = z.infer<typeof SpinSchema>;

export const HistorySpinSchema = SpinSchema.extend({
  djName: z.string(),
  hype: z.number().int(),
  skip: z.number().int(),
  eligibleVoters: z.number().int(),
});
export type HistorySpin = z.infer<typeof HistorySpinSchema>;

export const UpNextItemSchema = z.object({
  djUserId: IdSchema,
  track: TrackSchema.nullable(),
});
export type UpNextItem = z.infer<typeof UpNextItemSchema>;

export const ChatMessageSchema = z.object({
  id: IdSchema,
  roomId: IdSchema,
  userId: IdSchema,
  text: z.string(),
  /** Emoji reactions: emoji → user ids. */
  reactions: z.record(z.string(), z.array(IdSchema)).default({}),
  createdAt: TimestampSchema,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const SpeakerStatusSchema = z.enum(['off', 'starting', 'live', 'paused_elsewhere', 'error']);
export type SpeakerStatus = z.infer<typeof SpeakerStatusSchema>;

export const RoomSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  serverNow: TimestampSchema,
  room: RoomSchema,
  status: RoomStatusSchema,
  members: z.array(MemberSchema),
  booth: z.array(BoothSlotSchema),
  activeSlot: z.number().int().nullable(),
  queue: z.array(QueueEntrySchema),
  currentSpin: SpinSchema.nullable(),
  tally: TallySchema,
  upNext: z.array(UpNextItemSchema),
  recentChat: z.array(ChatMessageSchema),
  /** Caller-specific fields. */
  me: z
    .object({
      role: RoleSchema.nullable(),
      vote: VoteValueSchema.nullable(),
      speakerStatus: SpeakerStatusSchema,
      inQueue: z.boolean(),
      boothSlot: z.number().int().nullable(),
      cooldownUntil: TimestampSchema.nullable(),
    })
    .nullable(),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;

export const CrateItemSchema = z.object({
  id: IdSchema,
  position: z.number().int().nonnegative(),
  track: TrackSchema,
  /** Flags computed at add time (FR-C3, FR-D7, FR-L6). */
  flags: z.array(z.enum(['unplayable', 'too_long', 'explicit_blocked'])),
});
export type CrateItem = z.infer<typeof CrateItemSchema>;

export const CrateSchema = z.object({
  mode: z.enum(['playlist', 'local']),
  playlist: z.object({ id: z.string(), name: z.string(), url: z.string() }).nullable(),
  /** Index of the next track to play. */
  position: z.number().int().nonnegative(),
  items: z.array(CrateItemSchema),
  notice: z.string().nullable(),
});
export type Crate = z.infer<typeof CrateSchema>;

export const PlaylistSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  trackCount: z.number().int(),
  imageUrl: z.string().nullable(),
  ownedByMe: z.boolean(),
});
export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>;

export const InviteSchema = z.object({
  id: IdSchema,
  roomId: IdSchema,
  url: z.string(),
  token: z.string().optional(),
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  uses: z.number().int(),
  message: z.string(),
});
export type Invite = z.infer<typeof InviteSchema>;

export const SpeakerSchema = z.object({
  id: IdSchema,
  roomId: IdSchema,
  kind: z.enum(['web_sdk', 'fake', 'native_ios', 'native_android']),
  status: SpeakerStatusSchema,
  spotifyDeviceId: z.string().nullable(),
  lastHeartbeatAt: TimestampSchema.nullable(),
});
export type Speaker = z.infer<typeof SpeakerSchema>;

export const ApiTokenSchema = z.object({
  id: IdSchema,
  label: z.string(),
  scopes: z.array(z.string()),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const AvatarValidationIssueSchema = z.object({
  level: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
});
export type AvatarValidationIssue = z.infer<typeof AvatarValidationIssueSchema>;

export const AvatarImportReportSchema = z.object({
  ok: z.boolean(),
  avatar: AvatarSchema.nullable(),
  sourceFormat: AvatarSourceFormatSchema.nullable(),
  detectedSize: z.object({ w: z.number().int(), h: z.number().int() }).nullable(),
  /** Set when the sheet divides into cells but is not a known layout. */
  needsGrid: z.object({ cols: z.number().int(), rows: z.number().int() }).nullable(),
  frameCounts: z.record(z.string(), z.number().int()).nullable(),
  suggestedName: z.string().nullable(),
  /** Built runtime sheet + thumbnail for the live preview (also on dry runs). */
  preview: AvatarRefSchema.nullable(),
  issues: z.array(AvatarValidationIssueSchema),
});
export type AvatarImportReport = z.infer<typeof AvatarImportReportSchema>;

export const AvatarReportSchema = z.object({
  id: IdSchema,
  avatarId: IdSchema,
  reporterId: IdSchema,
  roomId: IdSchema.nullable(),
  reason: z.string(),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
  resolution: z.string().nullable(),
});
export type AvatarReport = z.infer<typeof AvatarReportSchema>;

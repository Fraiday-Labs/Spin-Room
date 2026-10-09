import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';

/** All times are UTC milliseconds (PRD data model). */
const ms = (name: string) => bigint(name, { mode: 'number' });

export const avatars = pgTable(
  'avatars',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id'),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['preset', 'custom'] }).notNull(),
    sourceFormat: text('source_format', { enum: ['preset', 'pet_v1', 'pet_v2', 'single_sheet'] }).notNull(),
    originalUrl: text('original_url'),
    originalKey: text('original_key'),
    sheetUrl: text('sheet_url').notNull(),
    thumbUrl: text('thumb_url').notNull(),
    sha256: text('sha256'),
    frameCounts: jsonb('frame_counts').$type<Record<string, number>>().notNull().default({}),
    rows: jsonb('rows').$type<{ state: string; frames: number; dimmed?: boolean; at?: number }[]>().notNull().default([]),
    grid: jsonb('grid').$type<{ cols: number; rows: number } | null>(),
    /** Uploaded sheets: every non-empty source row, and a small sheet of them for picking. */
    views: jsonb('views').$type<{ row: number; name: string; frames: number }[] | null>(),
    viewsUrl: text('views_url'),
    /** Owner's picks: state → source row. Missing states use the default mapping. */
    choices: jsonb('choices').$type<Record<string, number> | null>(),
    /** Owner's favourite views (source rows), up to AVATAR_FAVORITE_VIEWS: the shortlist they pick from. */
    favorites: jsonb('favorites').$type<number[] | null>(),
    /** Sheet-builder version that made `sheetUrl`; older uploads are rebuilt at boot. */
    build: integer('build').notNull().default(1),
    /** Uploaded by a site admin and offered to everyone alongside the built-in presets. */
    featured: boolean('featured').notNull().default(false),
    petJson: jsonb('pet_json').$type<Record<string, unknown> | null>(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'removed'] }).notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('avatars_owner_idx').on(t.ownerId), index('avatars_status_idx').on(t.status)],
);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  spotifyUserId: text('spotify_user_id').notNull().unique(),
  spotifyClientId: text('spotify_client_id'),
  displayName: text('display_name').notNull(),
  email: text('email'),
  avatarId: text('avatar_id').notNull().default('preset-bolt'),
  /** Preset others see while a custom avatar is pending review (FR-A13). */
  presetAvatarId: text('preset_avatar_id').notNull().default('preset-bolt'),
  avatarColor: text('avatar_color').notNull().default('#3DE2FF'),
  /** Storage key of an uploaded profile photo (256×256 WebP), shown in the account menu and profile. */
  photoKey: text('photo_key'),
  isPremium: boolean('is_premium').notNull().default(false),
  isAdmin: boolean('is_admin').notNull().default(false),
  points: integer('points').notNull().default(0),
  uploadRevoked: boolean('upload_revoked').notNull().default(false),
  violationCount: integer('violation_count').notNull().default(0),
  deletedAt: ms('deleted_at'),
  createdAt: ms('created_at').notNull(),
});

export const spotifyTokens = pgTable('spotify_tokens', {
  userId: text('user_id').primaryKey(),
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  accessTokenEnc: text('access_token_enc').notNull(),
  expiresAt: ms('expires_at').notNull(),
  scopes: text('scopes').notNull(),
  clientId: text('client_id').notNull(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    userAgent: text('user_agent'),
    createdAt: ms('created_at').notNull(),
    expiresAt: ms('expires_at').notNull(),
    revokedAt: ms('revoked_at'),
  },
  (t) => [uniqueIndex('sessions_refresh_idx').on(t.refreshHash), index('sessions_user_idx').on(t.userId)],
);

export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ownerId: text('owner_id').notNull(),
  visibility: text('visibility', { enum: ['public', 'invite_only'] }).notNull(),
  settingsJson: jsonb('settings_json').$type<Record<string, unknown>>().notNull(),
  createdAt: ms('created_at').notNull(),
  /** Closed by the owner: hidden from the directory, nobody can join, reopenable. */
  closedAt: ms('closed_at'),
  /** "Anyone with the link" key for invite-only rooms; null while link sharing is off. */
  shareToken: text('share_token'),
});

export const roomMembers = pgTable(
  'room_members',
  {
    roomId: text('room_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role', { enum: ['owner', 'moderator', 'member'] }).notNull(),
    banned: boolean('banned').notNull().default(false),
    muted: boolean('muted').notNull().default(false),
    avatarHidden: boolean('avatar_hidden').notNull().default(false),
    setMode: text('set_mode', { enum: ['playlist', 'local'] })
      .notNull()
      .default('local'),
    setPlaylistId: text('set_playlist_id'),
    setPlaylistName: text('set_playlist_name'),
    setSnapshotId: text('set_snapshot_id'),
    setPosition: integer('set_position').notNull().default(0),
    setNotice: text('set_notice'),
    joinedAt: ms('joined_at').notNull(),
    lastSeenAt: ms('last_seen_at'),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index('room_members_user_idx').on(t.userId)],
);

export const invites = pgTable(
  'invites',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: ms('created_at').notNull(),
    expiresAt: ms('expires_at'),
    revokedAt: ms('revoked_at'),
    uses: integer('uses').notNull().default(0),
  },
  (t) => [uniqueIndex('invites_token_idx').on(t.tokenHash), index('invites_room_idx').on(t.roomId)],
);

export const crateItems = pgTable(
  'crate_items',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    userId: text('user_id').notNull(),
    trackUri: text('track_uri').notNull(),
    title: text('title').notNull(),
    artists: jsonb('artists').$type<string[]>().notNull(),
    album: text('album').notNull().default(''),
    durationMs: integer('duration_ms').notNull(),
    artUrl: text('art_url'),
    explicit: boolean('explicit').notNull().default(false),
    playable: boolean('playable').notNull().default(true),
    position: integer('position').notNull(),
  },
  (t) => [index('crate_items_member_idx').on(t.roomId, t.userId, t.position)],
);

export const djQueue = pgTable(
  'dj_queue',
  {
    roomId: text('room_id').notNull(),
    userId: text('user_id').notNull(),
    position: integer('position').notNull(),
    joinedAt: ms('joined_at').notNull(),
    cooldownUntil: ms('cooldown_until'),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] })],
);

export const boothSlots = pgTable(
  'booth_slots',
  {
    roomId: text('room_id').notNull(),
    slot: integer('slot').notNull(),
    userId: text('user_id'),
    consecutiveSkips: integer('consecutive_skips').notNull().default(0),
    spinsThisTurn: integer('spins_this_turn').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.slot] })],
);

export const spins = pgTable(
  'spins',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    djUserId: text('dj_user_id').notNull(),
    trackUri: text('track_uri').notNull(),
    title: text('title').notNull(),
    artists: jsonb('artists').$type<string[]>().notNull(),
    album: text('album').notNull().default(''),
    artUrl: text('art_url'),
    explicit: boolean('explicit').notNull().default(false),
    durationMs: integer('duration_ms').notNull(),
    startedAt: ms('started_at').notNull(),
    endedAt: ms('ended_at'),
    endReason: text('end_reason', { enum: ['completed', 'auto_skip', 'dj_skip', 'mod_skip', 'dj_left', 'room_closed'] }),
    hypeCount: integer('hype_count').notNull().default(0),
    skipCount: integer('skip_count').notNull().default(0),
    eligibleVoters: integer('eligible_voters').notNull().default(0),
  },
  (t) => [index('spins_room_started_idx').on(t.roomId, t.startedAt)],
);

export const votes = pgTable(
  'votes',
  {
    spinId: text('spin_id').notNull(),
    userId: text('user_id').notNull(),
    value: text('value', { enum: ['hype', 'skip'] }).notNull(),
    updatedAt: ms('updated_at').notNull(),
    surface: text('surface', { enum: ['web', 'slack', 'mcp'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.spinId, t.userId] })],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    roomId: text('room_id').notNull(),
    userId: text('user_id').notNull(),
    text: text('text').notNull(),
    reactions: jsonb('reactions').$type<Record<string, string[]>>().notNull().default({}),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('chat_room_created_idx').on(t.roomId, t.createdAt)],
);

export const slackInstalls = pgTable('slack_installs', {
  teamId: text('team_id').primaryKey(),
  teamName: text('team_name'),
  botTokenEnc: text('bot_token_enc').notNull(),
  botUserId: text('bot_user_id'),
  installedBy: text('installed_by').notNull(),
  installedAt: ms('installed_at').notNull(),
});

export const slackLinks = pgTable(
  'slack_links',
  {
    teamId: text('team_id').notNull(),
    channelId: text('channel_id').notNull(),
    roomId: text('room_id').notNull(),
    cardMessageTs: text('card_message_ts'),
    messagesSinceCard: integer('messages_since_card').notNull().default(0),
    /** Who linked the channel: the card is rendered with their room access. */
    linkedByUserId: text('linked_by_user_id'),
    linkedBySlackUser: text('linked_by_slack_user'),
    createdAt: ms('created_at').notNull(),
    /** Short thread replies under the card: a new DJ, a crowd skip, a big hype. */
    momentsEnabled: boolean('moments_enabled').notNull().default(true),
    /** The Friday afternoon recap post. */
    recapEnabled: boolean('recap_enabled').notNull().default(true),
    /** IANA time zone of whoever linked the channel (when "Friday 4 pm" is). */
    timeZone: text('time_zone'),
    lastRecapAt: ms('last_recap_at'),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.channelId] }), index('slack_links_room_idx').on(t.roomId)],
);

export const identityLinks = pgTable(
  'identity_links',
  {
    userId: text('user_id').notNull(),
    provider: text('provider', { enum: ['slack', 'mcp'] }).notNull(),
    externalId: text('external_id').notNull(),
    teamId: text('team_id').notNull().default(''),
    createdAt: ms('created_at').notNull(),
    lastSurfaceAt: ms('last_surface_at'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.teamId, t.externalId] }), index('identity_links_user_idx').on(t.userId)],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind', { enum: ['pat', 'mcp_oauth'] })
      .notNull()
      .default('pat'),
    label: text('label').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default(['rooms']),
    clientId: text('client_id'),
    createdAt: ms('created_at').notNull(),
    lastUsedAt: ms('last_used_at'),
    revokedAt: ms('revoked_at'),
  },
  (t) => [uniqueIndex('api_tokens_hash_idx').on(t.tokenHash), index('api_tokens_user_idx').on(t.userId)],
);

export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: ms('created_at').notNull(),
});

export const speakers = pgTable(
  'speakers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    roomId: text('room_id').notNull(),
    kind: text('kind').notNull(),
    spotifyDeviceId: text('spotify_device_id'),
    status: text('status').notNull(),
    createdAt: ms('created_at').notNull(),
    lastHeartbeatAt: ms('last_heartbeat_at'),
    lastAudibleAt: ms('last_audible_at'),
    closedAt: ms('closed_at'),
  },
  (t) => [index('speakers_member_idx').on(t.roomId, t.userId)],
);

export const avatarReports = pgTable(
  'avatar_reports',
  {
    id: text('id').primaryKey(),
    avatarId: text('avatar_id').notNull(),
    reporterId: text('reporter_id').notNull(),
    roomId: text('room_id'),
    reason: text('reason').notNull(),
    createdAt: ms('created_at').notNull(),
    resolvedAt: ms('resolved_at'),
    resolution: text('resolution'),
  },
  (t) => [index('avatar_reports_open_idx').on(t.resolvedAt)],
);

export const blobs = pgTable('blobs', {
  sha256: text('sha256').primaryKey(),
  key: text('key').notNull(),
  contentType: text('content_type').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: ms('created_at').notNull(),
});

/** Product analytics events that feed the PRD success metrics. */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    userId: text('user_id'),
    roomId: text('room_id'),
    props: jsonb('props').$type<Record<string, unknown>>().notNull().default({}),
    at: ms('at').notNull(),
  },
  (t) => [index('analytics_name_at_idx').on(t.name, t.at)],
);

export const deletionRequests = pgTable('deletion_requests', {
  userId: text('user_id').primaryKey(),
  requestedAt: ms('requested_at').notNull(),
  completedAt: ms('completed_at'),
});

import { z } from 'zod';
import {
  ApiTokenSchema,
  AvatarImportReportSchema,
  AvatarViewChoicesSchema,
  AvatarViewsSchema,
  AvatarReportSchema,
  AvatarSchema,
  ChatMessageSchema,
  CrateSchema,
  HistorySpinSchema,
  IdSchema,
  InviteSchema,
  MeSchema,
  PlaylistSummarySchema,
  RoleSchema,
  RoomSchema,
  RoomSnapshotSchema,
  ShareLinkSchema,
  RoomSummarySchema,
  SpeakerSchema,
  SpeakerStatusSchema,
  SurfaceSchema,
  TallySchema,
  TimestampSchema,
  TrackSchema,
  VisibilitySchema,
  VoteValueSchema,
} from './models.js';
import { RoomSettingsPatchSchema } from './settings.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/**
 * none: anonymous; optional: user if present; user: signed-in user;
 * service: internal service credential (Slack, MCP); admin: Spinroom admin.
 */
export type AuthLevel = 'none' | 'optional' | 'user' | 'service' | 'admin';

export interface RouteDef<P extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType, B extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  method: HttpMethod;
  path: string;
  auth: AuthLevel;
  summary: string;
  params: P;
  query: Q;
  body: B;
  response: R;
  /** `redirect` handlers answer with a 302; `multipart` bodies are not JSON. */
  kind?: 'json' | 'redirect' | 'multipart';
  /** Writes are rate limited and accept Idempotency-Key. */
  write?: boolean;
}

const None = z.object({}).strict();
type NoneT = typeof None;

function route<P extends z.ZodType = NoneT, Q extends z.ZodType = NoneT, B extends z.ZodType = NoneT, R extends z.ZodType = z.ZodType>(def: {
  method: HttpMethod;
  path: string;
  auth: AuthLevel;
  summary: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  kind?: 'json' | 'redirect' | 'multipart';
}): RouteDef<P, Q, B, R> {
  return {
    ...def,
    params: (def.params ?? None) as P,
    query: (def.query ?? None) as Q,
    body: (def.body ?? None) as B,
    write: def.method !== 'GET',
  };
}

const Slug = z.object({ slug: z.string().min(1).max(64) });
/** Query-string boolean: accepts true/false and "true"/"false"/"1"/"0" (never `Boolean("false")`). */
const QueryBool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');
const Ok = z.object({ ok: z.literal(true) });
const SlugRe = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export const SPOTIFY_CLIENT_ID_RE = /^[0-9a-f]{32}$/i;

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  expiresAt: TimestampSchema,
  refreshToken: z.string().optional(),
});

export const routes = {
  // ---------------------------------------------------------------- auth
  'auth.spotifyStart': route({
    method: 'GET',
    path: '/v1/auth/spotify/start',
    auth: 'none',
    summary: 'Begin Spotify PKCE login with the user’s own Client ID (option B).',
    query: z.object({
      client_id: z.string().optional(),
      return_to: z.string().optional(),
      /** native clients get tokens back via a deep link instead of cookies */
      mode: z.enum(['cookie', 'token']).optional(),
    }),
    response: z.null(),
    kind: 'redirect',
  }),
  'auth.spotifyCallback': route({
    method: 'GET',
    path: '/v1/auth/spotify/callback',
    auth: 'none',
    summary: 'Spotify OAuth redirect target.',
    query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }),
    response: z.null(),
    kind: 'redirect',
  }),
  'auth.config': route({
    method: 'GET',
    path: '/v1/auth/config',
    auth: 'none',
    summary: 'Login configuration for the setup screen.',
    response: z.object({
      spotifyMode: z.enum(['real', 'fake']),
      callbackUrl: z.string(),
      rememberedClientId: z.string().nullable(),
      scopes: z.array(z.string()),
      /** Remote MCP endpoint for the Connect agent page. */
      mcpUrl: z.string(),
      /** The server has its own Spotify app (SPOTIFY_DEV_CLIENT_ID): people just sign in, no setup. */
      hostedSpotifyApp: z.boolean(),
      /** "Add to Slack" link, or null while the Slack app isn't configured on the server. */
      slackInstallUrl: z.string().nullable(),
    }),
  }),
  'auth.fakeLogin': route({
    method: 'POST',
    path: '/v1/auth/fake/login',
    auth: 'none',
    summary: 'Development only (SPOTIFY_MODE=fake): sign in as a fake Spotify user.',
    body: z.object({
      spotifyUserId: z.string().min(1).max(64),
      displayName: z.string().min(1).max(40).optional(),
      premium: z.boolean().default(true),
    }),
    response: TokenPairSchema.extend({ me: MeSchema }),
  }),
  'auth.refresh': route({
    method: 'POST',
    path: '/v1/auth/session/refresh',
    auth: 'none',
    summary: 'Rotate the refresh token and mint a new access token.',
    body: z.object({ refreshToken: z.string().optional() }),
    response: TokenPairSchema,
  }),
  'auth.logout': route({
    method: 'POST',
    path: '/v1/auth/logout',
    auth: 'optional',
    summary: 'End the current session.',
    response: Ok,
  }),
  'auth.tokenExchange': route({
    method: 'POST',
    path: '/v1/auth/token-exchange',
    auth: 'service',
    summary: 'Internal: Slack or MCP service exchanges a linked identity for a short-lived user token.',
    body: z.discriminatedUnion('grant', [
      z.object({ grant: z.literal('mcp'), subjectToken: z.string() }),
      z.object({ grant: z.literal('slack'), teamId: z.string(), slackUserId: z.string() }),
    ]),
    response: z.object({ accessToken: z.string(), expiresAt: TimestampSchema, userId: IdSchema }),
  }),
  'time.get': route({
    method: 'GET',
    path: '/v1/time',
    auth: 'none',
    summary: 'Server time for clock sync.',
    response: z.object({ serverNow: TimestampSchema }),
  }),

  // ---------------------------------------------------------------- me
  'me.get': route({ method: 'GET', path: '/v1/me', auth: 'user', summary: 'My profile.', response: MeSchema }),
  'me.patch': route({
    method: 'PATCH',
    path: '/v1/me',
    auth: 'user',
    summary: 'Update profile.',
    body: z.object({
      displayName: z.string().trim().min(1).max(40).optional(),
      avatarColor: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/)
        .optional(),
    }),
    response: MeSchema,
  }),
  'me.delete': route({
    method: 'DELETE',
    path: '/v1/me',
    auth: 'user',
    summary: 'Delete my account and personal data.',
    response: z.object({ ok: z.literal(true), completesBy: TimestampSchema }),
  }),
  'me.spotifyToken': route({
    method: 'GET',
    path: '/v1/me/spotify-token',
    auth: 'user',
    summary: 'Short-lived Spotify access token for the speaker page (origin-checked).',
    response: z.object({ accessToken: z.string(), expiresAt: TimestampSchema }),
  }),
  'me.setAvatar': route({
    method: 'PUT',
    path: '/v1/me/avatar',
    auth: 'user',
    summary: 'Choose a preset or one of my custom avatars.',
    body: z.object({ avatarId: IdSchema }),
    response: MeSchema,
  }),
  'me.setPhoto': route({
    method: 'PUT',
    path: '/v1/me/photo',
    auth: 'user',
    summary: 'Upload a profile photo (JPEG, PNG, WebP, GIF or HEIC up to 10 MB). Multipart; stored as a 256×256 WebP without metadata.',
    response: MeSchema,
    kind: 'multipart',
  }),
  'me.deletePhoto': route({
    method: 'DELETE',
    path: '/v1/me/photo',
    auth: 'user',
    summary: 'Remove my profile photo (back to the initial-letter circle).',
    response: MeSchema,
  }),
  'me.playlists': route({
    method: 'GET',
    path: '/v1/me/playlists',
    auth: 'user',
    summary: 'My Spotify playlists, for linking a set.',
    response: z.array(PlaylistSummarySchema),
  }),
  'me.linkIdentity': route({
    method: 'POST',
    path: '/v1/me/identity-links',
    auth: 'user',
    summary: 'Link a Slack identity using a signed link from the Slack app.',
    body: z.object({
      provider: z.literal('slack'),
      teamId: z.string(),
      externalId: z.string(),
      exp: TimestampSchema,
      sig: z.string(),
    }),
    response: Ok,
  }),
  'me.unlinkIdentity': route({
    method: 'DELETE',
    path: '/v1/me/identity-links/{provider}',
    auth: 'user',
    summary: 'Unlink Slack or MCP.',
    params: z.object({ provider: z.enum(['slack', 'mcp']) }),
    response: Ok,
  }),

  // ---------------------------------------------------------------- rooms
  'rooms.list': route({
    method: 'GET',
    path: '/v1/rooms',
    auth: 'optional',
    summary: 'My rooms or the public directory, with live counts.',
    query: z.object({
      filter: z.enum(['mine', 'public']).default('public'),
      q: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).default(0),
    }),
    response: z.object({ rooms: z.array(RoomSummarySchema), total: z.number().int() }),
  }),
  'rooms.create': route({
    method: 'POST',
    path: '/v1/rooms',
    auth: 'user',
    summary: 'Create a room.',
    body: z.object({
      name: z.string().trim().min(2).max(60),
      slug: z.string().regex(SlugRe, 'lowercase letters, digits and dashes').optional(),
      description: z.string().max(280).default(''),
      visibility: VisibilitySchema.default('public'),
      settings: RoomSettingsPatchSchema.optional(),
    }),
    response: z.object({ room: RoomSchema, invite: InviteSchema }),
  }),
  'rooms.get': route({
    method: 'GET',
    path: '/v1/rooms/{slug}',
    auth: 'optional',
    summary: 'Room snapshot.',
    params: Slug,
    response: RoomSnapshotSchema,
  }),
  'rooms.patch': route({
    method: 'PATCH',
    path: '/v1/rooms/{slug}',
    auth: 'user',
    summary: 'Edit room name, description, visibility or settings (owner/moderator).',
    params: Slug,
    body: z.object({
      name: z.string().trim().min(2).max(60).optional(),
      description: z.string().max(280).optional(),
      visibility: VisibilitySchema.optional(),
      settings: RoomSettingsPatchSchema.optional(),
    }),
    response: RoomSchema,
  }),
  'rooms.close': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/close',
    auth: 'user',
    summary: 'Close a room (owner): stops playback, sends everyone out and hides it. The owner can reopen it.',
    params: Slug,
    response: Ok,
  }),
  'rooms.reopen': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/reopen',
    auth: 'user',
    summary: 'Reopen a closed room (owner).',
    params: Slug,
    response: RoomSchema,
  }),
  'rooms.delete': route({
    method: 'DELETE',
    path: '/v1/rooms/{slug}',
    auth: 'user',
    summary: 'Delete a room for good (owner): members, invites, sets, history and chat. Spotify playlists are kept.',
    params: Slug,
    response: Ok,
  }),
  'rooms.join': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/join',
    auth: 'user',
    summary: 'Join a room (and mark present). Invite-only rooms need membership, an invite, the room’s share key, or a signed Slack channel link.',
    params: Slug,
    body: z.object({
      invite: z.string().optional(),
      /** "Anyone with the link" key from the room's share link. */
      key: z.string().max(100).optional(),
      /** From a linked Slack channel's "Join room" button. */
      slack: z.object({ teamId: z.string().max(40), channelId: z.string().max(40), sig: z.string().max(100) }).optional(),
    }),
    response: RoomSnapshotSchema,
  }),
  'rooms.shareLink': route({
    method: 'GET',
    path: '/v1/rooms/{slug}/share-link',
    auth: 'user',
    summary: 'The room’s share link (members).',
    params: Slug,
    response: ShareLinkSchema,
  }),
  'rooms.setLinkSharing': route({
    method: 'PUT',
    path: '/v1/rooms/{slug}/share-link',
    auth: 'user',
    summary: 'Turn "Anyone with the link" on or off for an invite-only room (owner/moderator).',
    params: Slug,
    body: z.object({ enabled: z.boolean() }),
    response: ShareLinkSchema,
  }),
  'rooms.resetShareLink': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/share-link/reset',
    auth: 'user',
    summary: 'Replace the share link; the old one stops working (owner/moderator).',
    params: Slug,
    response: ShareLinkSchema,
  }),
  'rooms.leave': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/leave',
    auth: 'user',
    summary: 'Leave a room: drops presence, the booth and the DJ queue.',
    params: Slug,
    response: Ok,
  }),
  'rooms.liveTicket': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/live-ticket',
    auth: 'user',
    summary: 'One-time ticket (30 s) for opening the live socket from another origin: wss://…/v1/rooms/{slug}/live?ticket=…',
    params: Slug,
    response: z.object({ ticket: z.string(), expiresAt: z.number().int() }),
  }),
  'rooms.members': route({
    method: 'GET',
    path: '/v1/rooms/{slug}/members',
    auth: 'user',
    summary: 'All members including away ones (moderators).',
    params: Slug,
    response: z.array(
      z.object({
        userId: IdSchema,
        displayName: z.string(),
        role: RoleSchema,
        banned: z.boolean(),
        muted: z.boolean(),
        lastSeenAt: TimestampSchema.nullable(),
      }),
    ),
  }),

  // ---------------------------------------------------------------- invites
  'invites.create': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/invites',
    auth: 'user',
    summary: 'Create an invite link.',
    params: Slug,
    body: z.object({
      expiresInMs: z
        .number()
        .int()
        .min(60_000)
        .max(90 * 86_400_000)
        .nullable()
        .optional(),
    }),
    response: InviteSchema,
  }),
  'invites.list': route({
    method: 'GET',
    path: '/v1/rooms/{slug}/invites',
    auth: 'user',
    summary: 'Active invites (owner/moderator).',
    params: Slug,
    response: z.array(InviteSchema),
  }),
  'invites.revoke': route({
    method: 'DELETE',
    path: '/v1/invites/{id}',
    auth: 'user',
    summary: 'Revoke an invite.',
    params: z.object({ id: IdSchema }),
    response: Ok,
  }),
  'invites.preview': route({
    method: 'GET',
    path: '/v1/invites/{token}',
    auth: 'none',
    summary: 'Room shown on an invite landing page.',
    params: z.object({ token: z.string() }),
    response: z.object({ room: RoomSummarySchema, expiresAt: TimestampSchema.nullable() }),
  }),
  'invites.accept': route({
    method: 'POST',
    path: '/v1/invites/{token}/accept',
    auth: 'user',
    summary: 'Join a room via invite.',
    params: z.object({ token: z.string() }),
    response: z.object({ room: RoomSchema }),
  }),

  // ---------------------------------------------------------------- crate ("My set")
  'crate.get': route({
    method: 'GET',
    path: '/v1/rooms/{slug}/crate',
    auth: 'user',
    summary: 'My set for this room.',
    params: Slug,
    response: CrateSchema,
  }),
  'crate.add': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/crate',
    auth: 'user',
    summary: 'Add a track by URI or by search query (first result). Appends to the linked playlist.',
    params: Slug,
    body: z
      .object({ trackUri: z.string().optional(), query: z.string().max(200).optional() })
      .refine((b) => b.trackUri || b.query, 'trackUri or query required'),
    response: CrateSchema,
  }),
  'crate.move': route({
    method: 'PATCH',
    path: '/v1/rooms/{slug}/crate/{itemId}',
    auth: 'user',
    summary: 'Move a track to a new position.',
    params: Slug.extend({ itemId: IdSchema }),
    body: z.object({ position: z.number().int().min(0) }),
    response: CrateSchema,
  }),
  'crate.remove': route({
    method: 'DELETE',
    path: '/v1/rooms/{slug}/crate/{itemId}',
    auth: 'user',
    summary: 'Remove a track.',
    params: Slug.extend({ itemId: IdSchema }),
    response: CrateSchema,
  }),
  'crate.clear': route({
    method: 'DELETE',
    path: '/v1/rooms/{slug}/crate',
    auth: 'user',
    summary:
      'Clear my whole set. A playlist Spinroom made for this set is emptied in Spotify too; a playlist you linked yourself is unlinked and left unchanged.',
    params: Slug,
    response: CrateSchema,
  }),
  'crate.import': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/crate/import',
    auth: 'user',
    summary: 'Link a Spotify playlist as my set, create a "Spinroom – <room>" playlist, or import read-only.',
    params: Slug,
    body: z.object({
      mode: z.enum(['link', 'create', 'copy']),
      playlist: z.string().optional(),
    }),
    response: CrateSchema,
  }),

  // ---------------------------------------------------------------- DJ queue, spins
  'djQueue.join': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/dj-queue',
    auth: 'user',
    summary: 'Join the DJ queue (needs ≥ 1 playable track in my set).',
    params: Slug,
    response: z.object({ queuePosition: z.number().int().nullable(), boothSlot: z.number().int().nullable() }),
  }),
  'djQueue.leave': route({
    method: 'DELETE',
    path: '/v1/rooms/{slug}/dj-queue',
    auth: 'user',
    summary: 'Leave the DJ queue or step down from the booth.',
    params: Slug,
    response: Ok,
  }),
  'spins.vote': route({
    method: 'PUT',
    path: '/v1/rooms/{slug}/spins/{spinId}/vote',
    auth: 'user',
    summary: 'Cast or change a vote (`current` allowed as spinId). Votes are visible in aggregate.',
    params: Slug.extend({ spinId: z.string() }),
    body: z.object({ value: VoteValueSchema.nullable() }),
    response: z.object({ spinId: IdSchema, tally: TallySchema, myVote: VoteValueSchema.nullable(), counted: z.boolean() }),
  }),
  'spins.skip': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/spins/current/skip',
    auth: 'user',
    summary: 'Skip the current spin (its DJ or a moderator).',
    params: Slug,
    response: Ok,
  }),
  'spins.votes': route({
    method: 'GET',
    path: '/v1/rooms/{slug}/spins/current/votes',
    auth: 'user',
    summary: 'Who voted what on the current spin (moderators only, FR-V6).',
    params: Slug,
    response: z.array(z.object({ userId: IdSchema, value: VoteValueSchema, surface: SurfaceSchema })),
  }),
  'rooms.history': route({
    method: 'GET',
    path: '/v1/rooms/{slug}/history',
    auth: 'optional',
    summary: 'Recent spins with scores.',
    params: Slug,
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }),
    response: z.array(HistorySpinSchema),
  }),

  // ---------------------------------------------------------------- chat, moderation
  'chat.send': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/chat',
    auth: 'user',
    summary: 'Send a chat message (visible to the room).',
    params: Slug,
    body: z.object({ text: z.string().trim().min(1).max(500) }),
    response: ChatMessageSchema,
  }),
  'chat.list': route({
    method: 'GET',
    path: '/v1/rooms/{slug}/chat',
    auth: 'optional',
    summary: 'Recent chat.',
    params: Slug,
    query: z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
    response: z.array(ChatMessageSchema),
  }),
  'chat.react': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/chat/{messageId}/reactions',
    auth: 'user',
    summary: 'Toggle an emoji reaction.',
    params: Slug.extend({ messageId: IdSchema }),
    body: z.object({ emoji: z.string().min(1).max(16) }),
    response: z.object({ reactions: z.record(z.string(), z.array(IdSchema)) }),
  }),
  'rooms.moderate': route({
    method: 'POST',
    path: '/v1/rooms/{slug}/moderation',
    auth: 'user',
    summary: 'Kick, ban, mute, end spin, set role, hide avatar.',
    params: Slug,
    body: z.object({
      action: z.enum(['kick', 'ban', 'unban', 'mute', 'unmute', 'end_spin', 'set_role', 'hide_avatar', 'unhide_avatar', 'remove_from_booth']),
      userId: IdSchema.optional(),
      role: z.enum(['moderator', 'member']).optional(),
    }),
    response: Ok,
  }),

  // ---------------------------------------------------------------- search
  'search.tracks': route({
    method: 'GET',
    path: '/v1/search/tracks',
    auth: 'user',
    summary: 'Spotify track search (proxied with my token, cached 10 minutes).',
    query: z.object({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(20).default(5) }),
    response: z.array(TrackSchema),
  }),

  // ---------------------------------------------------------------- speakers
  'speakers.register': route({
    method: 'POST',
    path: '/v1/speakers',
    auth: 'user',
    summary: 'Register a speaker for a room. One live speaker per member per room.',
    body: z.object({
      roomSlug: z.string(),
      kind: z.enum(['web_sdk', 'fake', 'native_ios', 'native_android']),
      spotifyDeviceId: z.string().nullable().optional(),
      takeover: z.boolean().default(false),
    }),
    response: SpeakerSchema,
  }),
  'speakers.heartbeat': route({
    method: 'POST',
    path: '/v1/speakers/{id}/heartbeat',
    auth: 'user',
    summary: 'Report speaker state, position and drift every 15 s.',
    params: z.object({ id: IdSchema }),
    body: z.object({
      status: SpeakerStatusSchema,
      spotifyDeviceId: z.string().nullable().optional(),
      spinId: z.string().nullable().optional(),
      positionMs: z.number().nullable().optional(),
      driftMs: z.number().nullable().optional(),
      audible: z.boolean().default(false),
      joinToAudioMs: z.number().nullable().optional(),
    }),
    response: z.object({ ok: z.literal(true), serverNow: TimestampSchema, superseded: z.boolean() }),
  }),
  'speakers.close': route({
    method: 'DELETE',
    path: '/v1/speakers/{id}',
    auth: 'user',
    summary: 'Stop a speaker.',
    params: z.object({ id: IdSchema }),
    response: Ok,
  }),

  // ---------------------------------------------------------------- tokens
  'tokens.list': route({ method: 'GET', path: '/v1/tokens', auth: 'user', summary: 'My personal API tokens.', response: z.array(ApiTokenSchema) }),
  'tokens.create': route({
    method: 'POST',
    path: '/v1/tokens',
    auth: 'user',
    summary: 'Create a personal API token (for the stdio MCP server). Shown once.',
    body: z.object({ label: z.string().trim().min(1).max(60) }),
    response: z.object({ token: z.string(), apiToken: ApiTokenSchema }),
  }),
  'tokens.revoke': route({
    method: 'DELETE',
    path: '/v1/tokens/{id}',
    auth: 'user',
    summary: 'Revoke a personal API token or MCP connection.',
    params: z.object({ id: IdSchema }),
    response: Ok,
  }),
  'linkCodes.create': route({
    method: 'POST',
    path: '/v1/link-codes',
    auth: 'user',
    summary: 'One-time code for `npx spinroom-mcp login <code>`.',
    response: z.object({ code: z.string(), expiresAt: TimestampSchema }),
  }),
  'linkCodes.redeem': route({
    method: 'POST',
    path: '/v1/link-codes/redeem',
    auth: 'none',
    summary: 'Exchange a one-time code for a personal API token.',
    body: z.object({ code: z.string(), label: z.string().max(60).default('spinroom-mcp') }),
    response: z.object({ token: z.string(), userId: IdSchema, displayName: z.string() }),
  }),

  // ---------------------------------------------------------------- MCP OAuth consent (web UI for /oauth/authorize)
  'oauth.request': route({
    method: 'GET',
    path: '/v1/oauth/requests/{id}',
    auth: 'user',
    summary: 'A pending MCP authorization request, shown on the consent screen.',
    params: z.object({ id: z.string() }),
    response: z.object({ clientName: z.string(), redirectHost: z.string(), scopes: z.array(z.string()) }),
  }),
  'oauth.approve': route({
    method: 'POST',
    path: '/v1/oauth/requests/{id}/approve',
    auth: 'user',
    summary: 'Approve or deny an MCP authorization request.',
    params: z.object({ id: z.string() }),
    body: z.object({ approve: z.boolean() }),
    response: z.object({ redirectTo: z.string() }),
  }),

  // ---------------------------------------------------------------- avatars
  'avatars.create': route({
    method: 'POST',
    path: '/v1/avatars',
    auth: 'user',
    summary: 'Import a ChatGPT pet (sprite kit zip, single sheet, or pet.json + sheet). Multipart.',
    query: z.object({
      dryRun: QueryBool.default(false),
      cols: z.coerce.number().int().optional(),
      rows: z.coerce.number().int().optional(),
      name: z.string().max(32).optional(),
      rightsConfirmed: QueryBool.default(false),
    }),
    response: AvatarImportReportSchema,
    kind: 'multipart',
  }),
  'avatars.presets': route({
    method: 'GET',
    path: '/v1/avatars/presets',
    auth: 'none',
    summary: 'Default avatars anyone can pick: the built-in ones, then ones a site admin made default.',
    response: z.array(AvatarSchema),
  }),
  'avatars.mine': route({ method: 'GET', path: '/v1/avatars/mine', auth: 'user', summary: 'My custom avatars.', response: z.array(AvatarSchema) }),
  'avatars.get': route({
    method: 'GET',
    path: '/v1/avatars/{id}',
    auth: 'optional',
    summary: 'An avatar (pending ones only for their owner).',
    params: z.object({ id: IdSchema }),
    response: AvatarSchema,
  }),
  'avatars.delete': route({
    method: 'DELETE',
    path: '/v1/avatars/{id}',
    auth: 'user',
    summary: 'Delete one of my custom avatars.',
    params: z.object({ id: IdSchema }),
    response: Ok,
  }),
  'avatars.views': route({
    method: 'GET',
    path: '/v1/avatars/{id}/views',
    auth: 'user',
    summary: 'Every view (row) of one of my uploaded avatars, and which one plays where.',
    params: z.object({ id: IdSchema }),
    response: AvatarViewsSchema,
  }),
  'avatars.setViews': route({
    method: 'PUT',
    path: '/v1/avatars/{id}/views',
    auth: 'user',
    summary: 'Choose which view of my uploaded avatar plays on the floor, at the booth, when DJing, and so on.',
    params: z.object({ id: IdSchema }),
    body: z.object({ choices: AvatarViewChoicesSchema }),
    response: AvatarViewsSchema,
  }),
  'avatars.report': route({
    method: 'POST',
    path: '/v1/avatars/{id}/report',
    auth: 'user',
    summary: 'Report an avatar to the global review queue.',
    params: z.object({ id: IdSchema }),
    body: z.object({ reason: z.string().trim().min(3).max(500), roomSlug: z.string().optional() }),
    response: Ok,
  }),
  'admin.avatarQueue': route({
    method: 'GET',
    path: '/v1/admin/avatars',
    auth: 'admin',
    summary: 'Pending avatars and open reports.',
    response: z.object({ pending: z.array(AvatarSchema), reports: z.array(AvatarReportSchema.extend({ avatar: AvatarSchema })) }),
  }),
  'admin.reviewAvatar': route({
    method: 'POST',
    path: '/v1/admin/avatars/{id}/review',
    auth: 'admin',
    summary: 'Approve, reject or remove an avatar everywhere.',
    params: z.object({ id: IdSchema }),
    body: z.object({ decision: z.enum(['approve', 'reject', 'remove']), note: z.string().max(500).optional() }),
    response: AvatarSchema,
  }),
  'admin.featureAvatar': route({
    method: 'PUT',
    path: '/v1/admin/avatars/{id}/featured',
    auth: 'admin',
    summary: 'Offer one of my uploaded avatars to everyone as a default (or stop offering it).',
    params: z.object({ id: IdSchema }),
    body: z.object({ featured: z.boolean() }),
    response: AvatarSchema,
  }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;
export type RouteParams<N extends RouteName> = z.input<Routes[N]['params']>;
export type RouteQuery<N extends RouteName> = z.input<Routes[N]['query']>;
export type RouteBody<N extends RouteName> = z.input<Routes[N]['body']>;
export type RouteResponse<N extends RouteName> = z.output<Routes[N]['response']>;

/** Fill `{name}` placeholders in a route path. */
export function buildPath(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing path param ${k}`);
    return encodeURIComponent(String(v));
  });
}

/** Fastify-style path (`:slug`) for a registry path (`{slug}`). */
export function toFastifyPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

export const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
] as const;

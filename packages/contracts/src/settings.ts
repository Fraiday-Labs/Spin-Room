import { z } from 'zod';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Every configurable number in the PRD, with its default. */
export const RoomSettingsSchema = z.object({
  /** FR-R4: max members present at once. */
  maxPresent: z.number().int().min(2).max(500).default(100),
  /** FR-R4: booth slots, 1 to 3. */
  boothSlots: z.number().int().min(1).max(3).default(3),
  /** FR-V3: auto-skip when Skip votes ≥ this share of eligible voters. */
  skipRatio: z.number().min(0.1).max(1).default(0.5),
  /** FR-V3: and at least this many Skip votes. */
  minSkips: z.number().int().min(1).max(50).default(2),
  /** FR-V4: bounce after this many consecutive auto-skips. */
  bounceAfter: z.number().int().min(1).max(10).default(2),
  /** FR-V4: bounced DJ cooldown. */
  bounceCooldownMs: z.number().int().min(0).max(60 * MINUTE).default(5 * MINUTE),
  /** FR-V5: Hype share that earns DJ points. */
  hypeRatio: z.number().min(0.1).max(1).default(0.5),
  /** FR-D5: spins per turn before returning to the queue; null = off. */
  turnLimit: z.number().int().min(1).max(50).nullable().default(null),
  /** FR-D7: refuse tracks longer than this. */
  maxTrackMs: z.number().int().min(MINUTE).max(60 * MINUTE).default(10 * MINUTE),
  /** FR-D8: block the same track within the last N spins; null = off. */
  noRepeatWindow: z.number().int().min(1).max(200).nullable().default(null),
  /** FR-L6: block explicit tracks. */
  blockExplicit: z.boolean().default(false),
  /** FR-R2: invite token lifetime. */
  inviteTtlMs: z.number().int().min(MINUTE).max(90 * DAY).default(7 * DAY),
  /** FR-L1: pause when no live speaker for this long. */
  pauseAfterNoSpeakerMs: z.number().int().min(10_000).max(60 * MINUTE).default(2 * MINUTE),
  /** FR-L2: remote presence window after a Slack/MCP action. */
  remotePresenceMs: z.number().int().min(MINUTE).max(120 * MINUTE).default(15 * MINUTE),
  /** FR-V2: heard audio within this window counts as eligible. */
  recentListenMs: z.number().int().min(MINUTE).max(120 * MINUTE).default(10 * MINUTE),
  /** FR-D4: DJ removed from booth after presence drops this long. */
  djPresenceDropMs: z.number().int().min(10_000).max(30 * MINUTE).default(60_000),
  /** FR-R7: chat rate limit. */
  chatMaxMessages: z.number().int().min(1).max(50).default(5),
  chatWindowMs: z.number().int().min(1000).max(MINUTE).default(10_000),
  /** Slack card: repost after this many newer channel messages. */
  slackRepostAfter: z.number().int().min(5).max(500).default(50),
});

export type RoomSettings = z.infer<typeof RoomSettingsSchema>;
export const RoomSettingsPatchSchema = RoomSettingsSchema.partial();
export type RoomSettingsPatch = z.infer<typeof RoomSettingsPatchSchema>;

export const DEFAULT_ROOM_SETTINGS: RoomSettings = RoomSettingsSchema.parse({});

/** Engine timing constants that are not per-room settings. */
export const TIMING = {
  /** Server advances a spin this long after its expected end (sync step 5). */
  endGraceMs: 2000,
  /** Fade on auto-skip / manual skip (FR-V3). */
  fadeMs: 3000,
  /** Speaker heartbeat interval. */
  heartbeatMs: 15_000,
  /** A speaker is live if it heartbeated within this window. */
  speakerLiveMs: 40_000,
  /** Clock sync ping interval and sample count. */
  clockPingMs: 30_000,
  clockSamples: 5,
  /** Drift correction loop. */
  driftCheckMs: 5000,
  driftSeekMs: 500,
  driftReloadMs: 3000,
  /** History kept per room (FR-R6). */
  historyLimit: 200,
  /** Up next panel length. */
  upNextCount: 3,
  /** Chat message length cap. */
  chatMaxLength: 500,
  /** Chat retention. */
  chatRetentionMs: 30 * DAY,
} as const;

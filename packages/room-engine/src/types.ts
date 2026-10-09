import type { EndReason, PresenceState, QueueEntry, Role, RoomEventBody, RoomSettings, RoomStatus, Surface, Track, VoteValue } from '@spinroom/contracts';

export interface MemberState {
  userId: string;
  role: Role;
  /** Open web connections (live socket). */
  sockets: number;
  /** Remote presence expiry from Slack/MCP actions (FR-L2). */
  remoteUntil: number;
  /** Last heartbeat of a live speaker; null when no speaker. */
  speakerAt: number | null;
  /** Last heartbeat that reported audible playback (FR-V2). */
  lastAudioAt: number | null;
  /** When the member stopped being present (FR-D4). */
  absentSince: number | null;
  /** Last broadcast presence/eligibility, to emit only changes. */
  presence: PresenceState;
  eligible: boolean;
}

export interface BoothSlotState {
  userId: string | null;
  spinsThisTurn: number;
  consecutiveSkips: number;
}

/**
 * The head of a member's set (crate) kept fresh by the runtime: the next few tracks in
 * cyclic order starting at the set position, and the set's total length.
 */
export interface SetPreview {
  tracks: Track[];
  length: number;
}

export interface VoteRecord {
  value: VoteValue;
  surface: Surface;
}

export interface EngineSpin {
  id: string;
  djUserId: string;
  slot: number;
  track: Track;
  startedAtServerMs: number;
  durationMs: number;
  votes: Record<string, VoteRecord>;
  /** While paused by its DJ: when the pause began. */
  pausedAt?: number | null;
}

export interface RoomState {
  roomId: string;
  settings: RoomSettings;
  status: RoomStatus;
  paused: boolean;
  members: Record<string, MemberState>;
  booth: BoothSlotState[];
  /** Slot of the current (or most recent) DJ; rotation continues after it. */
  activeSlot: number | null;
  queue: QueueEntry[];
  /** Bounce cooldowns that outlive queue membership (FR-V4). */
  cooldowns: Record<string, number>;
  current: EngineSpin | null;
  sets: Record<string, SetPreview>;
  /** Recently played track URIs, oldest first (FR-D8). */
  recent: string[];
  /** Last time any member had a live speaker (FR-L1). */
  lastSpeakerLiveAt: number;
  /** User already told they are up next for the coming spin (FR-L4). */
  upNextNotified: string | null;
}

export type Command =
  | { type: 'connect'; userId: string; role: Role }
  | { type: 'disconnect'; userId: string }
  | { type: 'remoteAction'; userId: string; role: Role }
  | { type: 'leave'; userId: string; kicked?: boolean }
  | { type: 'roleChanged'; userId: string; role: Role }
  | { type: 'speakerHeartbeat'; userId: string; live: boolean; audible: boolean; role?: Role }
  | { type: 'queueJoin'; userId: string }
  | { type: 'queueLeave'; userId: string }
  | { type: 'vote'; userId: string; spinId: string; value: VoteValue | null; surface: Surface }
  | { type: 'skip'; userId: string; by: 'dj' | 'mod' }
  | { type: 'pause'; userId: string; by: 'dj' | 'mod'; paused: boolean }
  | { type: 'removeFromBooth'; userId: string }
  | { type: 'timer'; spinId: string }
  | { type: 'setUpdated'; userId: string; preview: SetPreview }
  | { type: 'settings'; settings: RoomSettings }
  | { type: 'tick' };

export type Effect =
  | { type: 'schedule'; at: number; spinId: string }
  | { type: 'spinStarted'; spin: EngineSpin }
  /** A resumed spin's start moved later by the time it spent paused. */
  | { type: 'spinShifted'; spinId: string; startedAtServerMs: number }
  | {
      type: 'spinEnded';
      spinId: string;
      reason: EndReason;
      endedAt: number;
      hype: number;
      skip: number;
      eligibleVoters: number;
    }
  | { type: 'vote'; spinId: string; userId: string; value: VoteValue | null; surface: Surface }
  /** Move a member's set position forward by `by` tracks, then send a fresh preview. */
  | { type: 'advanceSet'; userId: string; by: number }
  /** Re-read a member's set (playlist snapshot) before their turn. */
  | { type: 'refreshSet'; userId: string }
  | { type: 'awardPoints'; userId: string; points: number; spinId: string };

export interface Env {
  now: number;
  newId: () => string;
}

export interface ApplyResult {
  state: RoomState;
  events: RoomEventBody[];
  effects: Effect[];
}

export type { EndReason };

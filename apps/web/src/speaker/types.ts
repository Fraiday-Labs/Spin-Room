import type { SpeakerStatus } from '@spinroom/contracts';

export interface PlayerState {
  uri: string | null;
  positionMs: number;
  paused: boolean;
}

/**
 * What the speaker needs from a player. The Spotify Web Playback SDK and the fake player
 * (SPOTIFY_MODE=fake) both implement it; a native speaker would too.
 */
export interface PlayerAdapter {
  readonly kind: 'web_sdk' | 'fake';
  /** Must be called from the user's click (autoplay rules). */
  connect(name: string): Promise<{ deviceId: string | null }>;
  play(uri: string, positionMs: number): Promise<void>;
  seek(positionMs: number): Promise<void>;
  pause(): Promise<void>;
  getState(): Promise<PlayerState | null>;
  setVolume(v: number): Promise<void>;
  /** Fires when Spotify moved playback to another device or the player dropped. */
  onLost(cb: () => void): void;
  onError(cb: (message: string) => void): void;
  disconnect(): void;
}

export interface SpeakerView {
  status: SpeakerStatus;
  message: string | null;
  driftMs: number | null;
  volume: number;
  muted: boolean;
}

import type { PlayerAdapter, PlayerState } from './types';

/**
 * A silent player for SPOTIFY_MODE=fake: keeps a position clock per "track" with a little
 * natural drift, so sync, heartbeats and Playwright runs behave like a real speaker.
 */
export class FakePlayer implements PlayerAdapter {
  readonly kind = 'fake' as const;
  private uri: string | null = null;
  private basePos = 0;
  private baseAt = 0;
  private paused = true;
  private lost: (() => void) | null = null;
  volume = 1;
  /** Simulated clock skew (ms per second of playback). */
  constructor(private readonly driftPerSec = 0, private readonly now: () => number = () => performance.now()) {}

  async connect() {
    return { deviceId: 'fake-device' };
  }
  async play(uri: string, positionMs: number) {
    this.uri = uri;
    this.basePos = positionMs;
    this.baseAt = this.now();
    this.paused = false;
  }
  async seek(positionMs: number) {
    this.basePos = positionMs;
    this.baseAt = this.now();
  }
  async pause() {
    this.basePos = this.position();
    this.baseAt = this.now();
    this.paused = true;
  }
  private position() {
    if (this.paused) return this.basePos;
    const dt = this.now() - this.baseAt;
    return this.basePos + dt + (dt / 1000) * this.driftPerSec;
  }
  async getState(): Promise<PlayerState | null> {
    return { uri: this.uri, positionMs: this.position(), paused: this.paused };
  }
  async setVolume(v: number) {
    this.volume = v;
  }
  onLost(cb: () => void) {
    this.lost = cb;
  }
  onError() {}
  disconnect() {
    this.paused = true;
  }
  /** Test hook: pretend another device took over. */
  simulateLost() {
    this.paused = true;
    this.lost?.();
  }
}

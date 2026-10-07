import { TIMING, type Spin, type SpeakerStatus } from '@spinroom/contracts';
import { DriftController, type ServerClock } from '@spinroom/sdk';
import type { PlayerAdapter, SpeakerView } from './types';

export interface SpeakerApi {
  register(takeover: boolean, deviceId: string | null): Promise<{ id: string }>;
  heartbeat(
    id: string,
    body: { status: SpeakerStatus; positionMs: number | null; driftMs: number | null; spinId: string | null; audible: boolean; spotifyDeviceId: string | null; joinToAudioMs: number | null },
  ): Promise<{ superseded: boolean }>;
  close(id: string): Promise<void>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as number),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as number),
};

/**
 * The speaker loop (PRD "Sync algorithm"): play each spin at
 * `positionMs = now + offset − startedAtServerMs`, correct drift every 5 s, heartbeat
 * every 15 s, fade on skips, and surface "Paused — Spotify is playing elsewhere".
 */
export class SpeakerController {
  view: SpeakerView = { status: 'off', message: null, driftMs: null, volume: 1, muted: false };
  private spin: Spin | null = null;
  private speakerId: string | null = null;
  private deviceId: string | null = null;
  private drift = new DriftController();
  private loop: unknown = null;
  private beat: unknown = null;
  private pending: unknown = null;
  private fadeTimer: unknown = null;
  private startedClickAt: number | null = null;
  private joinToAudioMs: number | null = null;
  private listeners = new Set<(v: SpeakerView) => void>();
  private busy = false;

  constructor(
    private readonly player: PlayerAdapter,
    private readonly clock: ServerClock,
    private readonly api: SpeakerApi,
    private readonly opts: { deviceName: string; timers?: Timers; localNow?: () => number } = { deviceName: 'Spinroom' },
  ) {}

  private get t() {
    return this.opts.timers ?? realTimers;
  }
  private localNow() {
    return (this.opts.localNow ?? Date.now)();
  }
  private serverNow() {
    return this.clock.now(this.localNow());
  }

  subscribe(fn: (v: SpeakerView) => void) {
    this.listeners.add(fn);
    fn(this.view);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SpeakerView>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l(this.view);
  }

  /** Call from the "Start speaker" click. */
  async start(takeover = false) {
    if (this.view.status === 'live' || this.view.status === 'starting') return;
    this.startedClickAt = this.localNow();
    this.set({ status: 'starting', message: null });
    try {
      this.player.onLost(() => this.handleLost());
      this.player.onError((m) => this.set({ message: m }));
      const { deviceId } = await this.player.connect(this.opts.deviceName);
      this.deviceId = deviceId;
      const sp = await this.api.register(takeover, deviceId);
      this.speakerId = sp.id;
      this.set({ status: 'live' });
      this.loop = this.t.setInterval(() => void this.correct(), TIMING.driftCheckMs);
      this.beat = this.t.setInterval(() => void this.heartbeat(), TIMING.heartbeatMs);
      await this.heartbeat();
      if (this.spin) await this.playCurrent();
    } catch (e) {
      this.set({ status: 'error', message: (e as Error).message });
      throw e;
    }
  }

  async stop(message: string | null = null) {
    this.clearTimers();
    try {
      await this.player.pause();
    } catch {
      /* ignore */
    }
    this.player.disconnect();
    if (this.speakerId) await this.api.close(this.speakerId).catch(() => {});
    this.speakerId = null;
    this.set({ status: 'off', message, driftMs: null });
  }

  private clearTimers() {
    if (this.loop) this.t.clearInterval(this.loop);
    if (this.beat) this.t.clearInterval(this.beat);
    if (this.pending) this.t.clearTimeout(this.pending);
    if (this.fadeTimer) this.t.clearInterval(this.fadeTimer);
    this.loop = this.beat = this.pending = this.fadeTimer = null;
  }

  /** The room's current spin changed (snapshot or spin.started). */
  async setSpin(spin: Spin | null) {
    const changed = spin?.id !== this.spin?.id;
    this.spin = spin;
    if (!changed) return;
    this.drift.reset();
    if (this.view.status !== 'live') return;
    if (!spin) {
      await this.player.pause().catch(() => {});
      return;
    }
    await this.playCurrent();
  }

  /** spin.ended: fade out over `fadeMs`, then pause until the next spin.started. */
  async endSpin(spinId: string, fadeMs: number) {
    if (this.spin?.id !== spinId) return;
    this.spin = null;
    if (this.view.status !== 'live') return;
    if (fadeMs <= 0) {
      await this.player.pause().catch(() => {});
      return;
    }
    const steps = 10;
    let i = 0;
    const base = this.effectiveVolume();
    if (this.fadeTimer) this.t.clearInterval(this.fadeTimer);
    this.fadeTimer = this.t.setInterval(() => {
      i++;
      void this.player.setVolume(base * Math.max(0, 1 - i / steps));
      if (i >= steps) {
        this.t.clearInterval(this.fadeTimer);
        this.fadeTimer = null;
        // Only pause if no new spin took over in the meantime.
        if (!this.spin) void this.player.pause().catch(() => {});
      }
    }, fadeMs / steps);
  }

  private effectiveVolume() {
    return this.view.muted ? 0 : this.view.volume;
  }

  async setVolume(volume: number, muted = this.view.muted) {
    this.set({ volume, muted });
    if (!this.fadeTimer) await this.player.setVolume(this.effectiveVolume()).catch(() => {});
  }

  /** Start the current spin at the expected position (late joiners use the same formula). */
  private async playCurrent() {
    const spin = this.spin;
    if (!spin) return;
    if (this.pending) this.t.clearTimeout(this.pending);
    if (this.fadeTimer) {
      this.t.clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    const pos = this.serverNow() - spin.startedAtServerMs;
    if (pos >= spin.durationMs) return;
    if (pos < 0) {
      // The spin starts after a fade; wait for it.
      this.pending = this.t.setTimeout(() => void this.playCurrent(), -pos);
      return;
    }
    await this.player.setVolume(this.effectiveVolume()).catch(() => {});
    try {
      await this.player.play(spin.track.uri, pos);
      if (this.startedClickAt !== null && this.joinToAudioMs === null) this.joinToAudioMs = this.localNow() - this.startedClickAt;
    } catch (e) {
      this.set({ message: (e as Error).message });
    }
  }

  /** Drift correction (every 5 s). */
  async correct() {
    if (this.busy || this.view.status !== 'live' || !this.spin) return;
    this.busy = true;
    try {
      const spin = this.spin;
      const expected = this.serverNow() - spin.startedAtServerMs;
      if (expected < 0 || expected >= spin.durationMs) return;
      const st = await this.player.getState();
      if (!st || st.uri !== spin.track.uri || st.paused) {
        await this.player.play(spin.track.uri, expected);
        return;
      }
      const action = this.drift.decide(expected, st.positionMs);
      this.set({ driftMs: Math.round(action.driftMs) });
      if (action.kind === 'seek') await this.player.seek(action.positionMs);
      else if (action.kind === 'reload') await this.player.play(spin.track.uri, action.positionMs);
    } catch (e) {
      this.set({ message: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }

  async heartbeat() {
    if (!this.speakerId) return;
    const st = await this.player.getState().catch(() => null);
    const live = this.view.status === 'live';
    const audible = live && !!st && !st.paused && this.effectiveVolume() > 0;
    try {
      const r = await this.api.heartbeat(this.speakerId, {
        status: this.view.status,
        positionMs: st ? Math.round(st.positionMs) : null,
        driftMs: this.view.driftMs,
        spinId: this.spin?.id ?? null,
        audible,
        spotifyDeviceId: this.deviceId,
        joinToAudioMs: this.joinToAudioMs,
      });
      this.joinToAudioMs = null;
      if (r.superseded) await this.stop('Your speaker moved to another tab.');
    } catch {
      /* transient; the next heartbeat retries */
    }
  }

  private handleLost() {
    if (this.view.status !== 'live') return;
    this.set({ status: 'paused_elsewhere', message: 'Paused — Spotify is playing elsewhere' });
    void this.heartbeat();
  }

  /** "Reclaim": take playback back on this device. */
  async reclaim() {
    if (this.view.status !== 'paused_elsewhere') return;
    this.set({ status: 'live', message: null });
    this.drift.reset();
    await this.playCurrent();
    await this.heartbeat();
  }
}

import { TIMING, spinElapsedMs, type Spin, type SpeakerStatus } from '@spinroom/contracts';
import { DriftController, type ServerClock } from '@spinroom/sdk';
import type { PlayerAdapter, SpeakerView } from './types';

export interface SpeakerApi {
  register(takeover: boolean, deviceId: string | null): Promise<{ id: string }>;
  heartbeat(
    id: string,
    body: {
      status: SpeakerStatus;
      positionMs: number | null;
      driftMs: number | null;
      spinId: string | null;
      audible: boolean;
      spotifyDeviceId: string | null;
      joinToAudioMs: number | null;
    },
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
  /** No drift judgement before this local time: Spotify is still buffering a play or seek. */
  private settleUntil = 0;
  /** Consecutive checks that found the player paused, empty or on another track. */
  private offTrackChecks = 0;
  /** Fade the next play in (switching rooms), rather than starting at full volume. */
  private fadeInNext = false;
  /** Bumped to cancel a volume ramp in progress (a new ramp, a volume change, stopping). */
  private rampId = 0;

  /** The server's id for this speaker while it's registered (closed on page unload). */
  get id() {
    return this.speakerId;
  }

  constructor(
    readonly player: PlayerAdapter,
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

  /**
   * Call from the "Start speaker" click. When switching rooms, `fadeIn` fades the first song in and
   * `after` (the old room fading out) is awaited just before it plays, while connecting runs alongside.
   */
  async start(takeover = false, opts: { fadeIn?: boolean; after?: Promise<unknown> } = {}) {
    if (this.view.status === 'live' || this.view.status === 'starting') return;
    this.startedClickAt = this.localNow();
    this.fadeInNext = !!opts.fadeIn;
    this.set({ status: 'starting', message: null });
    try {
      this.player.onLost(() => this.handleLost());
      this.player.onError((m) => this.set({ message: m }));
      const { deviceId } = await this.player.connect(this.opts.deviceName);
      this.deviceId = deviceId;
      // Already live in another tab (or on a page just reloaded): move it here; that tab is told and stops.
      const sp = await this.api.register(takeover, deviceId).catch((e: unknown) => {
        if ((e as { code?: string }).code === 'speaker_exists') return this.api.register(true, deviceId);
        throw e;
      });
      this.speakerId = sp.id;
      this.set({ status: 'live' });
      this.loop = this.t.setInterval(() => void this.correct(), TIMING.driftCheckMs);
      this.beat = this.t.setInterval(() => void this.heartbeat(), TIMING.heartbeatMs);
      if (opts.after) await opts.after;
      // Audio first (fastest join-to-audio), then report in; the heartbeat carries joinToAudioMs.
      if (this.spin) await this.playCurrent();
      await this.heartbeat();
    } catch (e) {
      this.set({ status: 'error', message: (e as Error).message });
      throw e;
    }
  }

  /**
   * Turn this speaker off. The player stays connected (it's shared by every room in this tab, and
   * reconnecting to Spotify takes seconds); it's paused only if this speaker was the one playing.
   */
  async stop(message: string | null = null) {
    const wasOn = this.view.status !== 'off';
    this.clearTimers();
    if (wasOn) await this.player.pause().catch(() => {});
    if (this.speakerId) await this.api.close(this.speakerId).catch(() => {});
    this.speakerId = null;
    this.set({ status: 'off', message, driftMs: null });
  }

  /**
   * Hand the player to another room's speaker: fade out over `fadeMs` and step off, without pausing
   * (the next room's song replaces this one on the same player, so there's no gap or click).
   */
  async handOff(fadeMs = 250) {
    if (this.view.status === 'off') return;
    this.clearTimers();
    const id = this.speakerId;
    this.speakerId = null;
    const from = this.effectiveVolume();
    this.set({ status: 'off', message: null, driftMs: null });
    if (id) void this.api.close(id).catch(() => {});
    await this.ramp(from, 0, fadeMs);
  }

  /** Take on another speaker's volume and mute (switching rooms keeps your levels). */
  adoptLevels(v: Pick<SpeakerView, 'volume' | 'muted'>) {
    this.set({ volume: v.volume, muted: v.muted });
  }

  /** Move the player's volume from `from` to `to` over `ms`; a later ramp or volume change cancels it. */
  private async ramp(from: number, to: number, ms: number) {
    const id = ++this.rampId;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await new Promise<void>((r) => this.t.setTimeout(r, ms / steps));
      if (id !== this.rampId) return;
      await this.player.setVolume(from + ((to - from) * i) / steps).catch(() => {});
    }
  }

  private clearTimers() {
    this.rampId++;
    if (this.loop) this.t.clearInterval(this.loop);
    if (this.beat) this.t.clearInterval(this.beat);
    if (this.pending) this.t.clearTimeout(this.pending);
    if (this.fadeTimer) this.t.clearInterval(this.fadeTimer);
    this.loop = this.beat = this.pending = this.fadeTimer = null;
  }

  /** The room's current spin changed (snapshot or spin.started). */
  async setSpin(spin: Spin | null) {
    const prev = this.spin;
    const changed = spin?.id !== prev?.id;
    this.spin = spin;
    if (!changed) {
      // Same spin: follow the DJ pausing or resuming it.
      if (!spin || !prev || !!spin.pausedAtServerMs === !!prev.pausedAtServerMs || this.view.status !== 'live') return;
      this.drift.reset();
      if (spin.pausedAtServerMs) await this.holdPaused();
      else await this.playCurrent();
      return;
    }
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
    this.rampId++;
    this.set({ volume, muted });
    if (!this.fadeTimer) await this.player.setVolume(this.effectiveVolume()).catch(() => {});
  }

  /** The DJ paused the track: stop playing and wait for the resume. */
  private async holdPaused() {
    if (this.pending) this.t.clearTimeout(this.pending);
    this.pending = null;
    if (this.fadeTimer) {
      this.t.clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    await this.player.pause().catch(() => {});
  }

  /** Start the current spin at the expected position (late joiners use the same formula). */
  private async playCurrent() {
    const spin = this.spin;
    if (!spin) return;
    if (spin.pausedAtServerMs) return this.holdPaused();
    if (this.pending) this.t.clearTimeout(this.pending);
    if (this.fadeTimer) {
      this.t.clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    const pos = spinElapsedMs(spin, this.serverNow());
    if (pos >= spin.durationMs) return;
    if (pos < 0) {
      // The spin starts after a fade; wait for it.
      this.pending = this.t.setTimeout(() => void this.playCurrent(), -pos);
      return;
    }
    // Switching rooms: start silent and fade in, after the last room faded out.
    const fade = this.fadeInNext;
    this.fadeInNext = false;
    await this.player.setVolume(fade ? 0 : this.effectiveVolume()).catch(() => {});
    try {
      await this.player.play(spin.track.uri, pos);
      if (fade) void this.ramp(0, this.effectiveVolume(), 500);
      this.settle();
      // Playing again: an earlier hiccup's message no longer applies.
      if (this.view.message && this.view.status === 'live') this.set({ message: null });
      if (this.startedClickAt !== null && this.joinToAudioMs === null) this.joinToAudioMs = this.localNow() - this.startedClickAt;
    } catch (e) {
      this.set({ message: (e as Error).message });
    }
  }

  /** After a play or seek, hold off judging drift while Spotify buffers. */
  private settle() {
    this.settleUntil = this.localNow() + TIMING.driftSettleMs;
    this.offTrackChecks = 0;
  }

  /** Drift correction (every 5 s). Every correction is audible, so act only on lasting problems. */
  async correct() {
    if (this.busy || this.view.status !== 'live' || !this.spin || this.spin.pausedAtServerMs) return;
    if (this.localNow() < this.settleUntil) return;
    this.busy = true;
    try {
      const spin = this.spin;
      const expected = spinElapsedMs(spin, this.serverNow());
      if (expected < 0 || expected >= spin.durationMs) return;
      const st = await this.player.getState();
      if (!st || st.uri !== spin.track.uri || st.paused) {
        // A buffering hiccup reads as paused for a moment; restart only if it lasts two checks.
        if (++this.offTrackChecks < 2) return;
        await this.player.play(spin.track.uri, expected);
        this.settle();
        return;
      }
      this.offTrackChecks = 0;
      const action = this.drift.decide(expected, st.positionMs);
      this.set({ driftMs: Math.round(action.driftMs) });
      if (action.kind === 'seek') {
        await this.player.seek(action.positionMs);
        this.settle();
      } else if (action.kind === 'reload') {
        await this.player.play(spin.track.uri, action.positionMs);
        this.settle();
      }
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

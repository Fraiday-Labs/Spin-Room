import type { PlayerAdapter, PlayerState } from './types';

/* Minimal typings for the Spotify Web Playback SDK. */
interface SdkState {
  paused: boolean;
  position: number;
  track_window: { current_track: { uri: string } | null };
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(ev: string, cb: (arg: never) => void): void;
  getCurrentState(): Promise<SdkState | null>;
  setVolume(v: number): Promise<void>;
  seek(ms: number): Promise<void>;
  pause(): Promise<void>;
  activateElement?(): Promise<void>;
}
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (o: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume: number }) => SdkPlayer };
  }
}

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
let sdkReady: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  sdkReady ??= new Promise<void>((resolve, reject) => {
    if (window.Spotify) return resolve();
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => reject(new Error('Could not load the Spotify player. Check your connection or ad blocker.'));
    document.head.appendChild(s);
  });
  return sdkReady;
}

/**
 * The Spotify Web Playback SDK as a Spinroom player. Tokens come from the API
 * (`/v1/me/spotify-token`, speaker page only); playback starts by URI on this device.
 */
export class SpotifyPlayer implements PlayerAdapter {
  readonly kind = 'web_sdk' as const;
  private player: SdkPlayer | null = null;
  private deviceId: string | null = null;
  private lostCb: (() => void) | null = null;
  private errorCb: ((m: string) => void) | null = null;
  private expectingUri: string | null = null;

  constructor(private readonly getToken: () => Promise<string>) {}

  private async api(method: string, path: string, body?: unknown) {
    const token = await this.getToken();
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`https://api.spotify.com/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok || res.status === 204) return;
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt));
        continue;
      }
      const j = await res.json().catch(() => null);
      throw new Error(j?.error?.message ?? `Spotify ${method} ${path} failed (${res.status})`);
    }
    throw new Error('Spotify is busy — retrying soon');
  }

  async connect(name: string) {
    await loadSdk();
    const P = window.Spotify!.Player;
    const player = new P({ name, volume: 1, getOAuthToken: (cb) => void this.getToken().then(cb, (e) => this.errorCb?.(String(e))) });
    this.player = player;
    // Must run inside the click handler on some browsers (autoplay policy).
    await player.activateElement?.();
    const ready = new Promise<string>((resolve, reject) => {
      player.addListener('ready', ({ device_id }: { device_id: string }) => resolve(device_id));
      player.addListener('initialization_error', ({ message }: { message: string }) => reject(new Error(message)));
      player.addListener('authentication_error', ({ message }: { message: string }) => reject(new Error(`Spotify sign-in problem: ${message}`)));
      player.addListener('account_error', () => reject(new Error('Spotify Premium is required to play in Spinroom.')));
    });
    player.addListener('not_ready', () => this.lostCb?.());
    player.addListener('playback_error', ({ message }: { message: string }) => this.errorCb?.(message));
    player.addListener('autoplay_failed', () => this.errorCb?.('The browser blocked audio — click Start speaker again.'));
    player.addListener('player_state_changed', (state: SdkState | null) => {
      // A null state means this device is no longer the active one (playing elsewhere).
      if (!state && this.expectingUri) this.lostCb?.();
    });
    if (!(await player.connect())) throw new Error('Could not connect to Spotify.');
    this.deviceId = await ready;
    return { deviceId: this.deviceId };
  }

  async play(uri: string, positionMs: number) {
    this.expectingUri = uri;
    await this.api('PUT', `/me/player/play?device_id=${encodeURIComponent(this.deviceId ?? '')}`, {
      uris: [uri],
      position_ms: Math.max(0, Math.round(positionMs)),
    });
  }
  async seek(positionMs: number) {
    await this.player?.seek(Math.max(0, Math.round(positionMs)));
  }
  async pause() {
    this.expectingUri = null;
    await this.player?.pause();
  }
  async getState(): Promise<PlayerState | null> {
    const s = await this.player?.getCurrentState();
    if (!s) return null;
    return { uri: s.track_window.current_track?.uri ?? null, positionMs: s.position, paused: s.paused };
  }
  async setVolume(v: number) {
    await this.player?.setVolume(Math.min(1, Math.max(0, v)));
  }
  onLost(cb: () => void) {
    this.lostCb = cb;
  }
  onError(cb: (m: string) => void) {
    this.errorCb = cb;
  }
  disconnect() {
    this.expectingUri = null;
    this.player?.disconnect();
  }
}

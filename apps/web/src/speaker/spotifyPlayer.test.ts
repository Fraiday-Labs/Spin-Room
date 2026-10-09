import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotifyPlayer, readSdkState, type SdkState } from './spotifyPlayer';

const state = (patch: Partial<SdkState> & { track?: SdkState['track_window']['current_track'] }): SdkState => ({
  paused: false,
  position: 10_000,
  track_window: { current_track: patch.track === undefined ? { uri: 'spotify:track:asked' } : patch.track },
  ...patch,
});

describe('readSdkState', () => {
  it('reports the requested URI when Spotify plays a relinked copy', () => {
    const s = state({ track: { uri: 'spotify:track:regional', linked_from: { uri: 'spotify:track:asked' } } });
    expect(readSdkState(s, 0).uri).toBe('spotify:track:asked');
    const legacy = state({ track: { uri: 'spotify:track:regional', linked_from_uri: 'spotify:track:asked' } });
    expect(readSdkState(legacy, 0).uri).toBe('spotify:track:asked');
    expect(readSdkState(state({}), 0).uri).toBe('spotify:track:asked');
    expect(readSdkState(state({ track: null }), 0).uri).toBeNull();
  });

  it('advances the position by the age of a playing state, not a paused one', () => {
    expect(readSdkState(state({ timestamp: 1_000 }), 1_800).positionMs).toBe(10_800);
    expect(readSdkState(state({ timestamp: 1_000, paused: true }), 1_800).positionMs).toBe(10_000);
    // Missing or implausible timestamps leave the position alone.
    expect(readSdkState(state({}), 1_800).positionMs).toBe(10_000);
    expect(readSdkState(state({ timestamp: 1_000 }), 120_000).positionMs).toBe(10_000);
  });
});

/** A stand-in for the Spotify SDK's Player: emits 'ready' on each connect with a fresh device id. */
class SdkStub {
  static made = 0;
  static last: SdkStub | null = null;
  listeners = new Map<string, ((a: unknown) => void)[]>();
  connects = 0;
  constructor() {
    SdkStub.made++;
    SdkStub.last = this;
  }
  addListener(ev: string, cb: (a: unknown) => void) {
    this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), cb]);
  }
  emit(ev: string, a?: unknown) {
    for (const cb of this.listeners.get(ev) ?? []) cb(a);
  }
  async connect() {
    this.connects++;
    setTimeout(() => this.emit('ready', { device_id: `dev${this.connects}` }), 0);
    return true;
  }
  disconnect() {}
  async getCurrentState() {
    return null;
  }
  async setVolume() {}
  async getVolume() {
    return 1;
  }
  async seek() {}
  async pause() {}
}

describe('SpotifyPlayer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('connects once per tab and reconnects the same SDK player after a drop', async () => {
    vi.stubGlobal('window', { Spotify: { Player: SdkStub } });
    SdkStub.made = 0;
    const p = new SpotifyPlayer(async () => 'token');
    expect(await p.connect('Spinroom')).toEqual({ deviceId: 'dev1' });
    // A second room in the same tab reuses the connection.
    expect(await p.connect('Spinroom')).toEqual({ deviceId: 'dev1' });
    expect(SdkStub.last!.connects).toBe(1);
    // The connection drops; the next click reconnects the same player, not a second one.
    SdkStub.last!.emit('not_ready', { device_id: 'dev1' });
    expect(await p.connect('Spinroom')).toEqual({ deviceId: 'dev2' });
    expect(SdkStub.made).toBe(1);
    expect(SdkStub.last!.connects).toBe(2);
  });
});

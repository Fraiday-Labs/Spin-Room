import { describe, expect, it } from 'vitest';
import { readSdkState, type SdkState } from './spotifyPlayer';

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

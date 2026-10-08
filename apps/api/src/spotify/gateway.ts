import type { PlaylistSummary, Track } from '@spinroom/contracts';

export interface SpotifyTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export interface SpotifyProfile {
  id: string;
  displayName: string;
  email: string | null;
  /** `premium`, `free`, `open`, … — only `premium` can run a speaker. */
  product: string;
  country: string | null;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  url: string;
  snapshotId: string;
  ownerId: string;
  tracks: Track[];
}

/** Errors the gateway raises; the HTTP layer maps them to problem codes. */
export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
  get isQuota() {
    return this.status === 429 && this.reason === 'QUOTA_EXCEEDED';
  }
}

/**
 * Every Spotify call Spinroom makes, always with the acting user's token.
 * The API never holds an app-level Spotify credential (option B).
 */
export interface SpotifyGateway {
  readonly mode: 'real' | 'fake';
  authorizeUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string; scopes: readonly string[] }): string;
  exchangeCode(p: { clientId: string; code: string; redirectUri: string; verifier: string }): Promise<SpotifyTokenSet>;
  refresh(p: { clientId: string; refreshToken: string }): Promise<SpotifyTokenSet>;
  getMe(token: string): Promise<SpotifyProfile>;
  searchTracks(token: string, q: string, limit: number): Promise<Track[]>;
  getTrack(token: string, uri: string): Promise<Track | null>;
  listMyPlaylists(token: string): Promise<PlaylistSummary[]>;
  getPlaylist(token: string, playlistId: string): Promise<PlaylistDetail>;
  getPlaylistSnapshot(token: string, playlistId: string): Promise<string>;
  createPlaylist(token: string, name: string, description: string): Promise<{ id: string; name: string; url: string; snapshotId: string }>;
  addToPlaylist(token: string, playlistId: string, uris: string[]): Promise<string>;
  removeFromPlaylist(token: string, playlistId: string, uri: string, position: number, snapshotId: string | null): Promise<string>;
  reorderPlaylist(token: string, playlistId: string, from: number, insertBefore: number, snapshotId: string | null): Promise<string>;
  /** Remove every track from a playlist. */
  clearPlaylist(token: string, playlistId: string): Promise<string>;
}

/** Accept a playlist ID, `spotify:playlist:…` URI or open.spotify.com URL. */
export function parsePlaylistId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]{10,40})/);
  if (m) return m[1]!;
  return /^[A-Za-z0-9]{10,40}$/.test(s) ? s : null;
}

export function parseTrackUri(input: string): string | null {
  const s = input.trim();
  const m = s.match(/track[/:]([A-Za-z0-9]{10,40})/);
  if (m) return `spotify:track:${m[1]}`;
  return null;
}

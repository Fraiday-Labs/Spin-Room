import type { PlaylistSummary, Track } from '@spinroom/contracts';
import { createHash } from 'node:crypto';
import { SpotifyApiError, type PlaylistDetail, type SpotifyGateway, type SpotifyProfile, type SpotifyTokenSet } from './gateway.js';

/**
 * Fake Spotify for development, tests and Playwright (SPOTIFY_MODE=fake).
 * Fictional artists and titles; covers are generated SVGs served by the API.
 */
const RAW: [string, string, string, number, boolean?, boolean?][] = [
  ['Neon Tide', 'The Velvet Pixels', 'Arcade Nights', 214_000],
  ['Booth Lights', 'Mira Kass', 'Floorplan', 187_000],
  ['Crate Digger', 'Low Orbit Club', 'Vinyl Weather', 241_000],
  ['Amber Marquee', 'Sable & Finch', 'Late Show', 198_000],
  ['Cyan Skyline', 'Haru Okabe', 'City Sleep', 226_000],
  ['Magenta Hour', 'Polly Static', 'Signals', 175_000],
  ['Hype Train', 'Dex Moreno', 'Platform 9', 203_000],
  ['Glow Stick Waltz', 'Ines Varga', 'Three Four', 232_000],
  ['Bass Under Brick', 'Concrete Bloom', 'Basement Tapes', 258_000],
  ['Spotlight Five', 'Truss Kids', 'Rig', 191_000],
  ['Pixel Rain', 'Kofi Mensah', 'Weatherproof', 219_000],
  ['Laptop Lid', 'Ada Byte', 'Commit', 166_000],
  ['Reflective Floor', 'Juno Park', 'Mirrors', 244_000],
  ['Equalizer', 'The Rainbow Bars', 'Levels', 207_000],
  ['Night Indigo', 'Sol Ferreira', 'Blue Hours', 236_000],
  ['Synth Lantern', 'Oda Lind', 'Lanterns', 182_000],
  ['Rotation', 'Round Robin', 'Slots', 199_000],
  ['Crowd Surf', 'Pigtails Inc.', 'Front Row', 213_000],
  ['Headphones Off', 'Quiet Remote', 'Away Status', 171_000],
  ['Up Next', 'Queue Theory', 'Waitlist', 224_000],
  ['Small Robot Dance', 'Beep Club', 'Servo', 185_000],
  ['Hooded Mascot', 'Team Spirit', 'Halftime', 229_000],
  ['Clock Offset', 'NTP Sisters', 'Median of Five', 196_000],
  ['Drift Under 500', 'Sync Lab', 'Milliseconds', 208_000],
  ['Late Joiner', 'Mid Song', 'Position Ms', 217_000],
  ['Fade Over Three', 'Soft Exit', 'Grace', 179_000],
  ['Brick Wall Echo', 'Concrete Bloom', 'Basement Tapes', 248_000],
  ['Marquee Scroll', 'Sable & Finch', 'Late Show', 205_000],
  ['Pocket Disco', 'Mira Kass', 'Floorplan', 193_000],
  ['Moonlit Crate', 'Low Orbit Club', 'Vinyl Weather', 239_000],
  ['Swear Jar', 'Loud Neighbors', 'Parental Advisory', 168_000, true],
  ['Region Locked', 'Nowhere Band', 'Unavailable', 201_000, false, true],
  ['Endless Jam', 'Long Form', 'Side B', 754_000],
  ['Quick Cut', 'Short Attention', 'Clips', 31_000],
  ['Tiny Loop', 'Short Attention', 'Clips', 24_000],
];

function idFor(title: string): string {
  return createHash('sha1').update(title).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 22);
}

export const FAKE_CATALOG: Track[] = RAW.map(([title, artist, album, durationMs, explicit, unplayable]) => {
  const id = idFor(title);
  return {
    uri: `spotify:track:${id}`,
    title,
    artists: [artist],
    album,
    artUrl: `/v1/fake-spotify/cover/${id}.svg`,
    durationMs,
    explicit: Boolean(explicit),
    playable: !unplayable,
  };
});

export function fakeCoverSvg(id: string): string {
  const h = createHash('md5').update(id).digest();
  const hue1 = h[0]! * 1.4;
  const hue2 = (hue1 + 90 + h[1]!) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 10 10"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue1},80%,55%)"/><stop offset="1" stop-color="hsl(${hue2},70%,25%)"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><circle cx="5" cy="5" r="${2 + (h[2]! % 3)}" fill="none" stroke="rgba(255,255,255,.5)" stroke-width=".3"/></svg>`;
}

interface FakePlaylist {
  id: string;
  name: string;
  owner: string;
  snapshot: number;
  uris: string[];
}

/** Fake access tokens encode the user: `fake.<spotifyUserId>.<premium|free>`. */
export function fakeAccessToken(spotifyUserId: string, premium: boolean) {
  return `fake.${spotifyUserId}.${premium ? 'premium' : 'free'}`;
}

function parseFake(token: string): { id: string; premium: boolean } {
  const [p, id, product] = token.split('.');
  if (p !== 'fake' || !id) throw new SpotifyApiError(401, 'invalid_token', 'Invalid fake token');
  return { id, premium: product === 'premium' };
}

export class FakeSpotifyGateway implements SpotifyGateway {
  readonly mode = 'fake' as const;
  private playlists = new Map<string, FakePlaylist>();
  private counter = 0;
  /** Simulate dev-mode playlist write lockout for tests. */
  playlistWritesBlocked = false;

  authorizeUrl(p: { state: string }) {
    return `/dev-login?state=${encodeURIComponent(p.state)}`;
  }

  async exchangeCode(p: { code: string }): Promise<SpotifyTokenSet> {
    // code format: `<spotifyUserId>.<premium|free>`
    const [id, product] = p.code.split('.');
    if (!id) throw new SpotifyApiError(400, 'invalid_grant', 'bad fake code');
    const accessToken = fakeAccessToken(id, product !== 'free');
    return { accessToken, refreshToken: `refresh.${accessToken}`, expiresAt: Date.now() + 3600_000, scope: 'streaming' };
  }

  async refresh(p: { refreshToken: string }): Promise<SpotifyTokenSet> {
    const accessToken = p.refreshToken.replace(/^refresh\./, '');
    return { accessToken, refreshToken: p.refreshToken, expiresAt: Date.now() + 3600_000, scope: 'streaming' };
  }

  async getMe(token: string): Promise<SpotifyProfile> {
    const { id, premium } = parseFake(token);
    return { id, displayName: id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), email: `${id}@example.test`, product: premium ? 'premium' : 'free', country: 'US' };
  }

  async searchTracks(token: string, q: string, limit: number): Promise<Track[]> {
    parseFake(token);
    const needle = q.toLowerCase().trim();
    const hits = FAKE_CATALOG.filter((t) => `${t.title} ${t.artists.join(' ')} ${t.album}`.toLowerCase().includes(needle));
    return (hits.length ? hits : needle === '*' ? FAKE_CATALOG : []).slice(0, Math.min(limit, 10));
  }

  async getTrack(token: string, uri: string): Promise<Track | null> {
    parseFake(token);
    return FAKE_CATALOG.find((t) => t.uri === uri) ?? null;
  }

  private ensureDefaults(owner: string) {
    if ([...this.playlists.values()].some((p) => p.owner === owner)) return;
    const pick = (start: number, n: number) => Array.from({ length: n }, (_, i) => FAKE_CATALOG[(start + i) % 30]!.uri);
    const seed = owner.length % 10;
    this.make(owner, 'Late Night Grooves', pick(seed, 8));
    this.make(owner, 'Coding Flow', pick(seed + 12, 6));
  }

  private make(owner: string, name: string, uris: string[]): FakePlaylist {
    const id = `fakepl${(++this.counter).toString().padStart(6, '0')}${owner.replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}`;
    const p = { id, name, owner, snapshot: 1, uris };
    this.playlists.set(id, p);
    return p;
  }

  private get(id: string): FakePlaylist {
    const p = this.playlists.get(id);
    if (!p) throw new SpotifyApiError(404, 'not_found', 'Playlist not found');
    return p;
  }

  private write(p: FakePlaylist) {
    if (this.playlistWritesBlocked) throw new SpotifyApiError(403, 'forbidden', 'Playlist writes are not available to this app');
    p.snapshot++;
    return `snap${p.snapshot}`;
  }

  async listMyPlaylists(token: string): Promise<PlaylistSummary[]> {
    const { id } = parseFake(token);
    this.ensureDefaults(id);
    return [...this.playlists.values()]
      .filter((p) => p.owner === id)
      .map((p) => ({ id: p.id, name: p.name, trackCount: p.uris.length, imageUrl: null, ownedByMe: true }));
  }

  async getPlaylist(token: string, playlistId: string): Promise<PlaylistDetail> {
    parseFake(token);
    const p = this.get(playlistId);
    return {
      id: p.id,
      name: p.name,
      url: `https://open.spotify.com/playlist/${p.id}`,
      snapshotId: `snap${p.snapshot}`,
      ownerId: p.owner,
      tracks: p.uris.map((u) => FAKE_CATALOG.find((t) => t.uri === u)).filter((t): t is Track => Boolean(t)),
    };
  }

  async getPlaylistSnapshot(token: string, playlistId: string) {
    parseFake(token);
    return `snap${this.get(playlistId).snapshot}`;
  }

  async createPlaylist(token: string, name: string) {
    const { id } = parseFake(token);
    if (this.playlistWritesBlocked) throw new SpotifyApiError(403, 'forbidden', 'Playlist writes are not available to this app');
    const p = this.make(id, name, []);
    return { id: p.id, name: p.name, url: `https://open.spotify.com/playlist/${p.id}`, snapshotId: 'snap1' };
  }

  async addToPlaylist(token: string, playlistId: string, uris: string[]) {
    parseFake(token);
    const p = this.get(playlistId);
    const snap = this.write(p);
    p.uris.push(...uris);
    return snap;
  }

  async removeFromPlaylist(token: string, playlistId: string, uri: string, position: number) {
    parseFake(token);
    const p = this.get(playlistId);
    const snap = this.write(p);
    if (p.uris[position] === uri) p.uris.splice(position, 1);
    else {
      const i = p.uris.indexOf(uri);
      if (i >= 0) p.uris.splice(i, 1);
    }
    return snap;
  }

  async reorderPlaylist(token: string, playlistId: string, from: number, insertBefore: number) {
    parseFake(token);
    const p = this.get(playlistId);
    const snap = this.write(p);
    const [u] = p.uris.splice(from, 1);
    if (u) p.uris.splice(insertBefore > from ? insertBefore - 1 : insertBefore, 0, u);
    return snap;
  }

  /** Test helper: edit a playlist "in the Spotify app". */
  externalEdit(playlistId: string, fn: (uris: string[]) => void) {
    const p = this.get(playlistId);
    fn(p.uris);
    p.snapshot++;
  }
}

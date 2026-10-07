import type { PlaylistSummary, Track } from '@spinroom/contracts';
import { SpotifyApiError, type PlaylistDetail, type SpotifyGateway, type SpotifyProfile, type SpotifyTokenSet } from './gateway.js';

interface Opts {
  accountsUrl: string;
  apiUrl: string;
  fetch?: typeof fetch;
  /** Retries for 429 (non-quota) and 5xx. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** Dev-mode search cap (Feb 2026 changes lowered the max page size to 10). */
const SEARCH_MAX = 10;

export function toTrack(t: Json): Track {
  return {
    uri: t.uri,
    title: t.name,
    artists: (t.artists ?? []).map((a: Json) => a.name),
    album: t.album?.name ?? '',
    artUrl: t.album?.images?.[0]?.url ?? null,
    durationMs: t.duration_ms,
    explicit: Boolean(t.explicit),
    // `is_playable` is present when a market is applied (from_token); restrictions mark region locks.
    playable: t.is_playable !== false && !t.restrictions && !t.is_local,
  };
}

export class RealSpotifyGateway implements SpotifyGateway {
  readonly mode = 'real' as const;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: Opts) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  authorizeUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string; scopes: readonly string[] }) {
    const q = new URLSearchParams({
      client_id: p.clientId,
      response_type: 'code',
      redirect_uri: p.redirectUri,
      state: p.state,
      code_challenge_method: 'S256',
      code_challenge: p.challenge,
      scope: p.scopes.join(' '),
    });
    return `${this.o.accountsUrl}/authorize?${q}`;
  }

  private async token(body: Record<string, string>): Promise<SpotifyTokenSet & { raw: Json }> {
    const res = await this.f(`${this.o.accountsUrl}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const json: Json = await res.json().catch(() => ({}));
    if (!res.ok) throw new SpotifyApiError(res.status, json.error ?? 'token_error', json.error_description ?? `token endpoint ${res.status}`);
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? body.refresh_token ?? '',
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      scope: json.scope ?? '',
      raw: json,
    };
  }

  exchangeCode(p: { clientId: string; code: string; redirectUri: string; verifier: string }) {
    return this.token({
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.verifier,
    });
  }

  refresh(p: { clientId: string; refreshToken: string }) {
    return this.token({ grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId });
  }

  /** Web API call with retry/backoff on 429 (except QUOTA_EXCEEDED) and 5xx. */
  private async api(token: string, method: string, path: string, body?: unknown): Promise<Json> {
    const retries = this.o.retries ?? 3;
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.o.apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 204) return null;
      const json: Json = await res.json().catch(() => null);
      if (res.ok) return json;
      const reason: string = json?.error?.reason ?? json?.error?.message ?? String(res.status);
      const err = new SpotifyApiError(res.status, reason, json?.error?.message ?? `Spotify ${method} ${path} → ${res.status}`);
      const retryable = (res.status === 429 && !err.isQuota) || res.status >= 500;
      if (!retryable || attempt >= retries) throw err;
      const ra = Number(res.headers.get('retry-after'));
      await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : delay);
      delay *= 2;
    }
  }

  /** Try the post-2026 path first, then the legacy one if it 404s. */
  private async apiWithFallback(token: string, method: string, paths: string[], body?: unknown): Promise<Json> {
    let last: unknown;
    for (const p of paths) {
      try {
        return await this.api(token, method, p, body);
      } catch (e) {
        last = e;
        if (!(e instanceof SpotifyApiError) || (e.status !== 404 && e.status !== 410)) throw e;
      }
    }
    throw last;
  }

  async getMe(token: string): Promise<SpotifyProfile> {
    const j = await this.api(token, 'GET', '/me');
    return { id: j.id, displayName: j.display_name ?? j.id, email: j.email ?? null, product: j.product ?? 'free', country: j.country ?? null };
  }

  async searchTracks(token: string, q: string, limit: number): Promise<Track[]> {
    const params = new URLSearchParams({ q, type: 'track', limit: String(Math.min(limit, SEARCH_MAX)), market: 'from_token' });
    const j = await this.api(token, 'GET', `/search?${params}`);
    return (j?.tracks?.items ?? []).filter(Boolean).map(toTrack);
  }

  async getTrack(token: string, uri: string): Promise<Track | null> {
    const id = uri.split(':').pop();
    try {
      return toTrack(await this.api(token, 'GET', `/tracks/${id}?market=from_token`));
    } catch (e) {
      if (e instanceof SpotifyApiError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }

  async listMyPlaylists(token: string): Promise<PlaylistSummary[]> {
    const me = await this.getMe(token);
    const out: PlaylistSummary[] = [];
    let path: string | null = '/me/playlists?limit=50';
    while (path && out.length < 200) {
      const j: Json = await this.api(token, 'GET', path);
      for (const p of j.items ?? []) {
        if (!p) continue;
        out.push({
          id: p.id,
          name: p.name,
          trackCount: p.items?.total ?? p.tracks?.total ?? 0,
          imageUrl: p.images?.[0]?.url ?? null,
          ownedByMe: p.owner?.id === me.id || Boolean(p.collaborative),
        });
      }
      path = j.next ? j.next.replace(this.o.apiUrl, '') : null;
    }
    return out;
  }

  async getPlaylist(token: string, playlistId: string): Promise<PlaylistDetail> {
    const meta = await this.api(token, 'GET', `/playlists/${playlistId}?fields=id,name,snapshot_id,owner(id),external_urls`);
    const tracks: Track[] = [];
    let offset = 0;
    for (;;) {
      const qs = `?limit=50&offset=${offset}&market=from_token`;
      const page: Json = await this.apiWithFallback(token, 'GET', [`/playlists/${playlistId}/items${qs}`, `/playlists/${playlistId}/tracks${qs}`]);
      const items = page?.items ?? [];
      for (const it of items) {
        const t = it.item ?? it.track;
        if (t && t.type !== 'episode' && t.uri?.startsWith('spotify:track:')) tracks.push(toTrack(t));
      }
      offset += items.length;
      if (!page?.next || items.length === 0 || offset >= 2000) break;
    }
    return {
      id: meta.id,
      name: meta.name,
      url: meta.external_urls?.spotify ?? `https://open.spotify.com/playlist/${meta.id}`,
      snapshotId: meta.snapshot_id,
      ownerId: meta.owner?.id ?? '',
      tracks,
    };
  }

  async getPlaylistSnapshot(token: string, playlistId: string): Promise<string> {
    const j = await this.api(token, 'GET', `/playlists/${playlistId}?fields=snapshot_id`);
    return j.snapshot_id;
  }

  async createPlaylist(token: string, name: string, description: string) {
    const body = { name, description, public: false };
    let j: Json;
    try {
      j = await this.api(token, 'POST', '/me/playlists', body);
    } catch (e) {
      if (!(e instanceof SpotifyApiError) || (e.status !== 404 && e.status !== 405)) throw e;
      const me = await this.getMe(token);
      j = await this.api(token, 'POST', `/users/${encodeURIComponent(me.id)}/playlists`, body);
    }
    return { id: j.id, name: j.name, url: j.external_urls?.spotify ?? `https://open.spotify.com/playlist/${j.id}`, snapshotId: j.snapshot_id };
  }

  async addToPlaylist(token: string, playlistId: string, uris: string[]) {
    const j = await this.apiWithFallback(token, 'POST', [`/playlists/${playlistId}/items`, `/playlists/${playlistId}/tracks`], { uris });
    return j.snapshot_id as string;
  }

  async removeFromPlaylist(token: string, playlistId: string, uri: string, position: number, snapshotId: string | null) {
    const body = { items: [{ uri, positions: [position] }], tracks: [{ uri, positions: [position] }], ...(snapshotId ? { snapshot_id: snapshotId } : {}) };
    const j = await this.apiWithFallback(token, 'DELETE', [`/playlists/${playlistId}/items`, `/playlists/${playlistId}/tracks`], body);
    return j.snapshot_id as string;
  }

  async reorderPlaylist(token: string, playlistId: string, from: number, insertBefore: number, snapshotId: string | null) {
    const body = { range_start: from, insert_before: insertBefore, range_length: 1, ...(snapshotId ? { snapshot_id: snapshotId } : {}) };
    const j = await this.apiWithFallback(token, 'PUT', [`/playlists/${playlistId}/items`, `/playlists/${playlistId}/tracks`], body);
    return j.snapshot_id as string;
  }
}

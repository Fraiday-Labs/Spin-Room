import { SpinroomError, type Crate, type CrateItem, type Track } from '@spinroom/contracts';
import { SET_PREVIEW_SIZE, type SetPreview } from '@spinroom/room-engine';
import { and, asc, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { crateItems, roomMembers } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { parsePlaylistId, parseTrackUri, SpotifyApiError } from '../spotify/gateway.js';
import { roomSettings, type MemberRow, type RoomRow } from './access.js';

type ItemRow = typeof crateItems.$inferSelect;

const FALLBACK_NOTICE = 'Spotify didn’t let Spinroom edit your playlist, so your set is now stored in Spinroom. Your Spotify playlist is unchanged.';

function rowToTrack(r: ItemRow): Track {
  return {
    uri: r.trackUri,
    title: r.title,
    artists: r.artists,
    album: r.album,
    artUrl: r.artUrl,
    durationMs: r.durationMs,
    explicit: r.explicit,
    playable: r.playable,
  };
}

/**
 * A member's set ("My set") for a room. Playlist mode mirrors a linked Spotify playlist into
 * `crate_items`; local mode keeps the set in Spinroom only (the dev-mode fallback).
 */
export function createSetService(ctx: AppContext) {
  async function items(roomId: string, userId: string): Promise<ItemRow[]> {
    return ctx.db
      .select()
      .from(crateItems)
      .where(and(eq(crateItems.roomId, roomId), eq(crateItems.userId, userId)))
      .orderBy(asc(crateItems.position));
  }

  async function member(roomId: string, userId: string): Promise<MemberRow> {
    const m = await ctx.db.query.roomMembers.findFirst({ where: and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)) });
    if (!m) throw new SpinroomError('not_member', 'Join the room first');
    return m;
  }

  async function updateMember(roomId: string, userId: string, patch: Partial<MemberRow>) {
    await ctx.db
      .update(roomMembers)
      .set(patch)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
  }

  /** Replace the cached items with `tracks` (in order). */
  async function writeItems(roomId: string, userId: string, tracks: Track[]) {
    await ctx.db.transaction(async (tx) => {
      await tx.delete(crateItems).where(and(eq(crateItems.roomId, roomId), eq(crateItems.userId, userId)));
      if (tracks.length) {
        await tx.insert(crateItems).values(
          tracks.map((t, i) => ({
            id: newId(),
            roomId,
            userId,
            trackUri: t.uri,
            title: t.title,
            artists: t.artists,
            album: t.album,
            durationMs: t.durationMs,
            artUrl: t.artUrl,
            explicit: t.explicit,
            playable: t.playable,
            position: i,
          })),
        );
      }
    });
  }

  async function token(userId: string) {
    return (await ctx.services.spotifyTokens.get(userId)).accessToken;
  }

  function flags(room: RoomRow, t: Track): CrateItem['flags'] {
    const s = roomSettings(room);
    const f: CrateItem['flags'] = [];
    if (!t.playable) f.push('unplayable');
    if (t.durationMs > s.maxTrackMs) f.push('too_long');
    if (s.blockExplicit && t.explicit) f.push('explicit_blocked');
    return f;
  }

  async function view(room: RoomRow, userId: string): Promise<Crate> {
    const m = await member(room.id, userId);
    const rows = await items(room.id, userId);
    return {
      mode: m.setMode,
      playlist: m.setPlaylistId
        ? { id: m.setPlaylistId, name: m.setPlaylistName ?? 'Playlist', url: `https://open.spotify.com/playlist/${m.setPlaylistId}` }
        : null,
      position: rows.length ? m.setPosition % rows.length : 0,
      items: rows.map((r, i) => ({ id: r.id, position: i, track: rowToTrack(r), flags: flags(room, rowToTrack(r)) })),
      notice: m.setNotice,
    };
  }

  /** Switch to Spinroom-side storage after Spotify refused a playlist write. */
  async function fallBackToLocal(roomId: string, userId: string) {
    await updateMember(roomId, userId, { setMode: 'local', setNotice: FALLBACK_NOTICE });
  }

  async function ensurePlaylist(room: RoomRow, m: MemberRow): Promise<MemberRow> {
    if (m.setMode === 'playlist' && m.setPlaylistId) return m;
    if (m.setNotice === FALLBACK_NOTICE) return m; // already fell back; stay local
    const existing = await items(room.id, m.userId);
    if (existing.length > 0) return m; // a local set already exists; don't move it silently
    try {
      const p = await ctx.spotify.createPlaylist(await token(m.userId), `Spinroom – ${room.name}`, `My set for the ${room.name} room on Spinroom`);
      await updateMember(room.id, m.userId, { setMode: 'playlist', setPlaylistId: p.id, setPlaylistName: p.name, setSnapshotId: p.snapshotId, setPosition: 0 });
      return { ...m, setMode: 'playlist', setPlaylistId: p.id, setPlaylistName: p.name, setSnapshotId: p.snapshotId, setPosition: 0 };
    } catch (e) {
      if (e instanceof SpotifyApiError && (e.status === 403 || e.status === 401)) {
        await fallBackToLocal(room.id, m.userId);
        return { ...m, setMode: 'local', setNotice: FALLBACK_NOTICE };
      }
      throw e;
    }
  }

  return {
    view,
    items,

    async preview(roomId: string, userId: string): Promise<SetPreview> {
      const rows = await items(roomId, userId);
      if (!rows.length) return { tracks: [], length: 0 };
      const m = await member(roomId, userId);
      const start = m.setPosition % rows.length;
      const n = Math.min(SET_PREVIEW_SIZE, rows.length);
      return { tracks: Array.from({ length: n }, (_, i) => rowToTrack(rows[(start + i) % rows.length]!)), length: rows.length };
    },

    /** FR-D6: move to the next unplayed track, wrapping to the top. */
    async advance(roomId: string, userId: string, by: number) {
      const rows = await items(roomId, userId);
      if (!rows.length) return;
      const m = await member(roomId, userId);
      await updateMember(roomId, userId, { setPosition: (m.setPosition + by) % rows.length });
    },

    /** Re-read a linked playlist when its snapshot ID changed (edits made in Spotify). */
    async refresh(roomId: string, userId: string): Promise<boolean> {
      const m = await member(roomId, userId);
      if (m.setMode !== 'playlist' || !m.setPlaylistId) return false;
      const t = await token(userId);
      const snap = await ctx.spotify.getPlaylistSnapshot(t, m.setPlaylistId);
      if (snap === m.setSnapshotId) return false;
      const before = await items(roomId, userId);
      const nextUri = before.length ? before[m.setPosition % before.length]?.trackUri : undefined;
      const p = await ctx.spotify.getPlaylist(t, m.setPlaylistId);
      await writeItems(roomId, userId, p.tracks);
      // Keep pointing at the same upcoming track if it is still there.
      const idx = nextUri ? p.tracks.findIndex((x) => x.uri === nextUri) : -1;
      await updateMember(roomId, userId, { setSnapshotId: p.snapshotId, setPlaylistName: p.name, setPosition: idx >= 0 ? idx : 0 });
      return true;
    },

    async add(room: RoomRow, userId: string, input: { trackUri?: string; query?: string }): Promise<Crate> {
      const t = await token(userId);
      let track: Track | null = null;
      if (input.trackUri) {
        const uri = parseTrackUri(input.trackUri);
        if (!uri) throw new SpinroomError('validation_failed', 'Not a Spotify track URI or link');
        track = await ctx.spotify.getTrack(t, uri);
      } else if (input.query) {
        track = (await ctx.spotify.searchTracks(t, input.query, 1))[0] ?? null;
      }
      if (!track) throw new SpinroomError('not_found', 'No matching track on Spotify');
      const s = roomSettings(room);
      if (track.durationMs > s.maxTrackMs) {
        throw new SpinroomError('track_too_long', `Tracks longer than ${Math.round(s.maxTrackMs / 60000)} minutes aren’t allowed in this room`);
      }
      if (s.blockExplicit && track.explicit) throw new SpinroomError('track_explicit', 'This room blocks explicit tracks');

      const m = await ensurePlaylist(room, await member(room.id, userId));
      if (m.setMode === 'playlist' && m.setPlaylistId) {
        try {
          const snap = await ctx.spotify.addToPlaylist(t, m.setPlaylistId, [track.uri]);
          await updateMember(room.id, userId, { setSnapshotId: snap });
        } catch (e) {
          if (!(e instanceof SpotifyApiError && e.status === 403)) throw e;
          await fallBackToLocal(room.id, userId);
        }
      }
      const rows = await items(room.id, userId);
      await ctx.db.insert(crateItems).values({
        id: newId(),
        roomId: room.id,
        userId,
        trackUri: track.uri,
        title: track.title,
        artists: track.artists,
        album: track.album,
        durationMs: track.durationMs,
        artUrl: track.artUrl,
        explicit: track.explicit,
        playable: track.playable,
        position: rows.length,
      });
      return view(room, userId);
    },

    async remove(room: RoomRow, userId: string, itemId: string): Promise<Crate> {
      const rows = await items(room.id, userId);
      const idx = rows.findIndex((r) => r.id === itemId);
      if (idx < 0) throw new SpinroomError('not_found', 'That track isn’t in your set');
      const m = await member(room.id, userId);
      if (m.setMode === 'playlist' && m.setPlaylistId) {
        try {
          const snap = await ctx.spotify.removeFromPlaylist(await token(userId), m.setPlaylistId, rows[idx]!.trackUri, idx, m.setSnapshotId);
          await updateMember(room.id, userId, { setSnapshotId: snap });
        } catch (e) {
          if (!(e instanceof SpotifyApiError && e.status === 403)) throw e;
          await fallBackToLocal(room.id, userId);
        }
      }
      const rest = rows.filter((_, i) => i !== idx).map(rowToTrack);
      await writeItems(room.id, userId, rest);
      const pos = m.setPosition % rows.length;
      await updateMember(room.id, userId, { setPosition: rest.length ? (idx < pos ? pos - 1 : pos) % rest.length : 0 });
      return view(room, userId);
    },

    /**
     * Empty the whole set. A "Spinroom – …" playlist we made is emptied in Spotify as well (so
     * the next add reuses it); a playlist the member linked themselves is unlinked, untouched.
     */
    async clear(room: RoomRow, userId: string): Promise<Crate> {
      const m = await member(room.id, userId);
      let keepLink = false;
      if (m.setMode === 'playlist' && m.setPlaylistId && (m.setPlaylistName ?? '').startsWith('Spinroom – ')) {
        try {
          const snap = await ctx.spotify.clearPlaylist(await token(userId), m.setPlaylistId);
          await updateMember(room.id, userId, { setSnapshotId: snap });
          keepLink = true;
        } catch (e) {
          if (!(e instanceof SpotifyApiError && (e.status === 403 || e.status === 404))) throw e;
        }
      }
      await writeItems(room.id, userId, []);
      await updateMember(
        room.id,
        userId,
        keepLink
          ? { setPosition: 0, setNotice: null }
          : { setMode: 'local', setPlaylistId: null, setPlaylistName: null, setSnapshotId: null, setPosition: 0, setNotice: null },
      );
      return view(room, userId);
    },

    async move(room: RoomRow, userId: string, itemId: string, to: number): Promise<Crate> {
      const rows = await items(room.id, userId);
      const from = rows.findIndex((r) => r.id === itemId);
      if (from < 0) throw new SpinroomError('not_found', 'That track isn’t in your set');
      const target = Math.min(Math.max(0, to), rows.length - 1);
      if (from === target) return view(room, userId);
      const m = await member(room.id, userId);
      if (m.setMode === 'playlist' && m.setPlaylistId) {
        try {
          const snap = await ctx.spotify.reorderPlaylist(await token(userId), m.setPlaylistId, from, target > from ? target + 1 : target, m.setSnapshotId);
          await updateMember(room.id, userId, { setSnapshotId: snap });
        } catch (e) {
          if (!(e instanceof SpotifyApiError && e.status === 403)) throw e;
          await fallBackToLocal(room.id, userId);
        }
      }
      const tracks = rows.map(rowToTrack);
      const [t] = tracks.splice(from, 1);
      tracks.splice(target, 0, t!);
      await writeItems(room.id, userId, tracks);
      return view(room, userId);
    },

    /** Link a playlist as the set, create a fresh one, or copy one read-only into a local set. */
    async importPlaylist(room: RoomRow, userId: string, mode: 'link' | 'create' | 'copy', playlist?: string): Promise<Crate> {
      const t = await token(userId);
      if (mode === 'create') {
        await updateMember(room.id, userId, { setMode: 'local', setPlaylistId: null, setNotice: null });
        await writeItems(room.id, userId, []);
        await ensurePlaylist(room, await member(room.id, userId));
        return view(room, userId);
      }
      const id = playlist ? parsePlaylistId(playlist) : null;
      if (!id) throw new SpinroomError('validation_failed', 'Paste a Spotify playlist link or ID');
      const p = await ctx.spotify.getPlaylist(t, id);
      await writeItems(room.id, userId, p.tracks);
      if (mode === 'link') {
        await updateMember(room.id, userId, {
          setMode: 'playlist',
          setPlaylistId: p.id,
          setPlaylistName: p.name,
          setSnapshotId: p.snapshotId,
          setPosition: 0,
          setNotice: null,
        });
      } else {
        await updateMember(room.id, userId, {
          setMode: 'local',
          setPlaylistId: null,
          setPlaylistName: null,
          setSnapshotId: null,
          setPosition: 0,
          setNotice: null,
        });
      }
      return view(room, userId);
    },
  };
}
export type SetService = ReturnType<typeof createSetService>;

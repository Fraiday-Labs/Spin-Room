import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import type { RoomConn } from '../room/store';
import { serverClock, syncClock } from './clock';
import { SpeakerController } from './controller';
import { FakePlayer } from './fakePlayer';
import { listening, registerRoomSpeaker, startListening } from './session';
import { SpotifyPlayer } from './spotifyPlayer';
import type { PlayerAdapter, SpeakerView } from './types';

export { serverClock, syncClock } from './clock';

async function spotifyToken(): Promise<string> {
  const r = await fetch('/v1/me/spotify-token', { credentials: 'include' });
  if (!r.ok) throw new Error('Could not get a Spotify token — reconnect Spotify.');
  return ((await r.json()) as { accessToken: string }).accessToken;
}

const OFF_VIEW: SpeakerView = { status: 'off', message: null, driftMs: null, volume: 1, muted: false };

/**
 * One player per tab, shared by every room's speaker: it stays connected to Spotify, so switching
 * rooms (or Listen again after Stop) doesn't wait for a new connection.
 */
let shared: { mode: 'real' | 'fake'; player: PlayerAdapter } | null = null;
function sharedPlayer(mode: 'real' | 'fake') {
  if (shared?.mode !== mode) shared = { mode, player: mode === 'fake' ? new FakePlayer() : new SpotifyPlayer(spotifyToken) };
  return shared.player;
}

export function createSpeaker(slug: string, mode: 'real' | 'fake') {
  const player = sharedPlayer(mode);
  return new SpeakerController(
    player,
    serverClock,
    {
      register: async (takeover, deviceId) =>
        api.call('speakers.register', { body: { roomSlug: slug, kind: player.kind, spotifyDeviceId: deviceId, takeover } }),
      heartbeat: async (id, body) => api.call('speakers.heartbeat', { params: { id }, body }),
      close: async (id) => {
        await api.call('speakers.close', { params: { id } });
      },
    },
    // The name Spotify shows for this browser in its device list (one device for every room).
    { deviceName: 'Spinroom' },
  );
}

/** The speaker for a room page: the one already playing in this tab if it's this room's, else a new one. */
export function useSpeaker(slug: string, roomName: string, spotifyMode: 'real' | 'fake' | undefined, conn: RoomConn) {
  // Keep the room's name out of the controller's identity: recreating the controller when the
  // name loads (or changes) would drop the live spin.
  const nameRef = useRef(roomName);
  nameRef.current = roomName;
  const controller = useMemo(() => {
    if (!spotifyMode) return null;
    const cur = listening.get();
    if (cur?.slug === slug) return cur.controller;
    return createSpeaker(slug, spotifyMode);
  }, [slug, spotifyMode]);

  const view = useSyncExternalStore<SpeakerView>(
    (cb) => {
      if (!controller) return () => {};
      const off = controller.subscribe(cb);
      return () => {
        off();
      };
    },
    () => controller?.view ?? OFF_VIEW,
  );

  useEffect(() => {
    void syncClock().catch(() => {});
    // Test hook (fake Spotify only): lets end-to-end tests read the simulated player.
    if (controller && spotifyMode === 'fake') (window as unknown as { __speaker?: SpeakerController }).__speaker = controller;
    // Leaving the room page: a speaker that's playing keeps playing (see session.ts); any other stops.
    return () => {
      if (!listening.owns(controller)) void controller?.stop();
    };
  }, [controller, spotifyMode]);

  useEffect(() => listening.setRoomName(slug, roomName), [slug, roomName]);
  useEffect(() => (controller ? registerRoomSpeaker(slug, controller, conn) : undefined), [slug, controller, conn]);

  return {
    controller,
    view,
    async start() {
      // Errors show on the speaker button (the controller's view); nothing more to do here.
      if (controller) await startListening(slug, nameRef.current, controller, conn).catch(() => {});
    },
  };
}

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api } from '../lib/api';
import type { RoomConn } from '../room/store';
import { serverClock, syncClock } from './clock';
import { SpeakerController } from './controller';
import { FakePlayer } from './fakePlayer';
import { listening, startListening } from './session';
import { SpotifyPlayer } from './spotifyPlayer';
import type { SpeakerView } from './types';

export { serverClock, syncClock } from './clock';

async function spotifyToken(): Promise<string> {
  const r = await fetch('/v1/me/spotify-token', { credentials: 'include' });
  if (!r.ok) throw new Error('Could not get a Spotify token — reconnect Spotify.');
  return ((await r.json()) as { accessToken: string }).accessToken;
}

const OFF_VIEW: SpeakerView = { status: 'off', message: null, driftMs: null, volume: 1, muted: false };

export function createSpeaker(slug: string, mode: 'real' | 'fake', deviceName: () => string) {
  const player = mode === 'fake' ? new FakePlayer() : new SpotifyPlayer(spotifyToken);
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
    {
      get deviceName() {
        return deviceName();
      },
    },
  );
}

/** The speaker for a room page: the one already playing in this tab if it's this room's, else a new one. */
export function useSpeaker(slug: string, roomName: string, spotifyMode: 'real' | 'fake' | undefined, conn: RoomConn) {
  // The device name is read when the speaker starts. Keep it out of the controller's identity:
  // recreating the controller when the room's name loads (or changes) would drop the live spin.
  const nameRef = useRef(roomName);
  nameRef.current = roomName;
  const controller = useMemo(() => {
    if (!spotifyMode) return null;
    const cur = listening.get();
    if (cur?.slug === slug) return cur.controller;
    return createSpeaker(slug, spotifyMode, () => `Spinroom — ${nameRef.current}`);
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

  return {
    controller,
    view,
    async start() {
      // Errors show on the speaker button (the controller's view); nothing more to do here.
      if (controller) await startListening(slug, nameRef.current, controller, conn).catch(() => {});
    },
  };
}

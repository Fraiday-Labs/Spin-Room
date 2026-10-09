import type { RoomEvent, RoomSnapshot } from '@spinroom/contracts';
import { ServerClock } from '@spinroom/sdk';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api, readCookie } from '../lib/api';
import { SpeakerController } from './controller';
import { FakePlayer } from './fakePlayer';
import { SpotifyPlayer } from './spotifyPlayer';
import type { SpeakerView } from './types';

/** Shared server clock: seeded by `/v1/time` pings and refreshed by live-socket pongs. */
export const serverClock = new ServerClock();

export async function syncClock(samples = 5) {
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const { serverNow } = await api.call('time.get');
    serverClock.addRoundTrip(t0, serverNow, Date.now());
  }
}

async function spotifyToken(): Promise<string> {
  const r = await fetch('/v1/me/spotify-token', { credentials: 'include' });
  if (!r.ok) throw new Error('Could not get a Spotify token — reconnect Spotify.');
  return ((await r.json()) as { accessToken: string }).accessToken;
}

const OFF_VIEW: SpeakerView = { status: 'off', message: null, driftMs: null, volume: 1, muted: false };

/** One speaker controller per room page. */
export function useSpeaker(slug: string, roomName: string, spotifyMode: 'real' | 'fake' | undefined) {
  // The device name is read when the speaker starts. Keep it out of the controller's identity:
  // recreating the controller when the room's name loads (or changes) would drop the live spin.
  const nameRef = useRef(roomName);
  nameRef.current = roomName;
  const controller = useMemo(() => {
    if (!spotifyMode) return null;
    const player = spotifyMode === 'fake' ? new FakePlayer() : new SpotifyPlayer(spotifyToken);
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
          return `Spinroom — ${nameRef.current}`;
        },
      },
    );
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
    if (!controller) return;
    // Leaving or reloading the page: free the speaker now, so starting again (here or in another
    // tab) doesn't find this one still "live" for up to 40 s.
    const leave = () => {
      const id = controller.id;
      if (!id) return;
      const csrf = readCookie('sr_csrf');
      void fetch(`/v1/speakers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
        keepalive: true,
        headers: csrf ? { 'x-csrf-token': csrf } : {},
      }).catch(() => {});
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [controller]);

  useEffect(() => {
    void syncClock().catch(() => {});
    // Test hook (fake Spotify only): lets end-to-end tests read the simulated player.
    if (controller && spotifyMode === 'fake') (window as unknown as { __speaker?: SpeakerController }).__speaker = controller;
    return () => void controller?.stop();
  }, [controller, spotifyMode]);

  return {
    controller,
    view,
    async start() {
      // Errors show on the speaker button (the controller's view); nothing more to do here.
      await controller?.start().catch(() => {});
    },
    /** Feed live room changes to the speaker. */
    onRoom(snapshot: RoomSnapshot | null, ev: RoomEvent | null) {
      if (!controller) return;
      if (ev?.type === 'spin.ended') void controller.endSpin(ev.spinId, ev.fadeMs);
      else if (ev?.type === 'user.notice' && ev.kind === 'speaker_moved') void controller.heartbeat();
      else if (snapshot) void controller.setSpin(snapshot.currentSpin);
    },
  };
}

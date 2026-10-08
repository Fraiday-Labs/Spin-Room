import type { RoomEvent, RoomSnapshot } from '@spinroom/contracts';
import { LiveRoom, type LiveStatus } from '@spinroom/sdk';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { liveRoomUrl } from '../lib/api';
import { serverClock } from '../speaker/useSpeaker';

export interface LiveState {
  snapshot: RoomSnapshot | null;
  status: LiveStatus;
  error: string | null;
  lastEvent: RoomEvent | null;
}

/** Small external store for the live room (no state library needed). */
class RoomStore {
  state: LiveState = { snapshot: null, status: 'connecting', error: null, lastEvent: null };
  private subs = new Set<() => void>();
  private eventSubs = new Set<(e: RoomEvent, s: RoomSnapshot | null) => void>();
  set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    for (const s of this.subs) s();
  }
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  onEvent(fn: (e: RoomEvent, s: RoomSnapshot | null) => void): () => void {
    this.eventSubs.add(fn);
    return () => {
      this.eventSubs.delete(fn);
    };
  }
  emit(e: RoomEvent, s: RoomSnapshot | null) {
    for (const f of this.eventSubs) f(e, s);
  }
}

export function useLiveRoom(slug: string, myUserId: string | null | undefined, enabled: boolean) {
  const [store] = useState(() => new RoomStore());
  const live = useRef<LiveRoom | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const room = new LiveRoom({
      url: () => liveRoomUrl(slug, !!myUserId),
      connect: (u) => {
        const ws = new WebSocket(u);
        ws.addEventListener('message', (m) => {
          // Surface connection errors (not_member, banned…) to the page.
          try {
            const msg = JSON.parse(String(m.data));
            if (msg.type === 'error') store.set({ error: msg.message });
          } catch {
            /* ignore */
          }
        });
        return ws as never;
      },
      myUserId: myUserId ?? null,
      onSnapshot: (s) => store.set({ snapshot: s, error: null }),
      onEvent: (e, s) => {
        store.set({ lastEvent: e });
        store.emit(e, s);
      },
      onStatus: (status) => store.set({ status }),
      onPong: (_rtt, offset) => serverClock.addSample(offset),
    });
    live.current = room;
    return () => room.close();
  }, [slug, myUserId, enabled, store]);
  const state = useSyncExternalStore(store.subscribe, () => store.state);
  return { ...state, store, resync: () => live.current?.resync(), patch: (fn: (s: RoomSnapshot) => RoomSnapshot) => live.current?.patch(fn) };
}

/** Re-render every `ms` (for progress bars and countdowns). */
export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setNow(serverClock.now()), ms);
    return () => clearInterval(h);
  }, [ms, active]);
  return now;
}

/** Stable small hash for deterministic crowd placement. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

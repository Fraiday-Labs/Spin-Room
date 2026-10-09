import type { RoomEvent, RoomSnapshot } from '@spinroom/contracts';
import { LiveRoom, type LiveStatus } from '@spinroom/sdk';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { liveRoomUrl } from '../lib/api';
import { serverClock } from '../speaker/clock';

export interface LiveState {
  snapshot: RoomSnapshot | null;
  status: LiveStatus;
  error: string | null;
  lastEvent: RoomEvent | null;
}

/** Small external store for the live room (no state library needed). */
const INITIAL: LiveState = { snapshot: null, status: 'connecting', error: null, lastEvent: null };

class RoomStore {
  state: LiveState = INITIAL;
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

/**
 * One live connection per room, shared by whoever needs it: the room page, and your speaker while
 * it plays (so music keeps going on other pages). It opens with the first user and closes with
 * the last.
 */
export interface RoomConn {
  key: string;
  slug: string;
  userId: string | null;
  store: RoomStore;
  live: LiveRoom | null;
  refs: number;
}
const conns = new Map<string, RoomConn>();

export function roomConn(slug: string, userId: string | null): RoomConn {
  const key = `${slug}|${userId ?? ''}`;
  let c = conns.get(key);
  if (!c) {
    c = { key, slug, userId, store: new RoomStore(), live: null, refs: 0 };
    conns.set(key, c);
  }
  return c;
}

/** Hold the room's live connection open; call the returned function to let go. */
export function acquireRoom(c: RoomConn): () => void {
  c.refs++;
  if (!c.live) {
    const store = c.store;
    c.live = new LiveRoom({
      url: () => liveRoomUrl(c.slug, !!c.userId),
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
      myUserId: c.userId,
      onSnapshot: (s) => store.set({ snapshot: s, error: null }),
      onEvent: (e, s) => {
        store.set({ lastEvent: e });
        store.emit(e, s);
      },
      onStatus: (status) => store.set({ status }),
      onPong: (_rtt, offset) => serverClock.addSample(offset),
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    c.refs--;
    if (c.refs > 0) return;
    c.live?.close();
    c.live = null;
    c.store.set(INITIAL);
  };
}

export function useLiveRoom(slug: string, myUserId: string | null | undefined, enabled: boolean) {
  const conn = useMemo(() => roomConn(slug, myUserId ?? null), [slug, myUserId]);
  useEffect(() => {
    if (!enabled) return;
    return acquireRoom(conn);
  }, [conn, enabled]);
  const state = useSyncExternalStore(conn.store.subscribe, () => conn.store.state);
  return { ...state, conn, store: conn.store, resync: () => conn.live?.resync(), patch: (fn: (s: RoomSnapshot) => RoomSnapshot) => conn.live?.patch(fn) };
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

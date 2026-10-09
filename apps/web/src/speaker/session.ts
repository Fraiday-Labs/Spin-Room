import { readCookie } from '../lib/api';
import { acquireRoom, type RoomConn } from '../room/store';
import type { SpeakerController } from './controller';

/**
 * The room you're listening to in this tab. It outlives the room page: leave for your profile or
 * the lobby and the music keeps playing, with "Listening" in the top bar. One at a time: starting
 * a speaker in another room stops this one.
 */
export interface Listening {
  slug: string;
  roomName: string;
  controller: SpeakerController;
}

interface Active extends Listening {
  conn: RoomConn;
  release: () => void;
  offEvents: () => void;
  offView: () => void;
}

let active: Active | null = null;
let shown: Listening | null = null;
const subs = new Set<() => void>();
const changed = () => {
  shown = active ? { slug: active.slug, roomName: active.roomName, controller: active.controller } : null;
  for (const f of subs) f();
};

export const listening = {
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },
  get: (): Listening | null => shown,
  /** Whether this controller is the one playing in this tab (so its room page mustn't stop it). */
  owns: (c: SpeakerController | null) => !!c && active?.controller === c,
  setRoomName(slug: string, name: string) {
    if (active?.slug === slug && active.roomName !== name) {
      active.roomName = name;
      changed();
    }
  },
};

function end() {
  const a = active;
  if (!a) return;
  active = null;
  a.offEvents();
  a.offView();
  a.release();
  changed();
}

/**
 * Start listening to `conn`'s room with `controller` (from the Listen button). Stops whatever
 * else this tab was playing, then keeps the room's live connection open and feeds its events to
 * the speaker until it's turned off.
 */
export async function startListening(slug: string, roomName: string, controller: SpeakerController, conn: RoomConn) {
  if (active && active.controller !== controller) {
    const prev = active.controller;
    end();
    await prev.stop();
  }
  if (!active) {
    const release = acquireRoom(conn);
    const offEvents = conn.store.onEvent((ev, snap) => {
      if (ev.type === 'spin.ended') void controller.endSpin(ev.spinId, ev.fadeMs);
      else if (ev.type === 'user.notice' && ev.kind === 'speaker_moved') void controller.heartbeat();
      else if (snap) void controller.setSpin(snap.currentSpin);
      // The owner closed or deleted the room: nothing left to hear.
      if (ev.type === 'room.closed') void controller.stop();
    });
    // Turned off (Stop, moved to another tab, signed out…): the session ends.
    const offView = controller.subscribe((v) => {
      if (v.status === 'off' && active?.controller === controller) end();
    });
    active = { slug, roomName, controller, conn, release, offEvents, offView };
    changed();
  }
  const snap = conn.store.state.snapshot;
  if (snap) await controller.setSpin(snap.currentSpin);
  await controller.start();
}

/** Speakers of the room pages currently open, so switching to that room reuses the page's own. */
const pages = new Map<string, { controller: SpeakerController; conn: RoomConn }>();

/** A room page offers its speaker for switching while it's open. */
export function registerRoomSpeaker(slug: string, controller: SpeakerController, conn: RoomConn) {
  pages.set(slug, { controller, conn });
  return () => {
    if (pages.get(slug)?.controller === controller) pages.delete(slug);
  };
}

/**
 * Switch what this tab is listening to (from the Listening menu): the open room page's speaker
 * if there is one, else a new one from `make`. The current room stops; one click, no Stop/Listen.
 */
export async function switchListening(slug: string, roomName: string, make: () => { controller: SpeakerController; conn: RoomConn }) {
  if (active?.slug === slug) return;
  const { controller, conn } = pages.get(slug) ?? make();
  await startListening(slug, roomName, controller, conn);
}

// Leaving or reloading the page: free the speaker now, so starting again (here or in another
// tab) doesn't find this one still "live" for up to 40 s.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const id = active?.controller.id;
    if (!id) return;
    const csrf = readCookie('sr_csrf');
    void fetch(`/v1/speakers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
      keepalive: true,
      headers: csrf ? { 'x-csrf-token': csrf } : {},
    }).catch(() => {});
  });
}

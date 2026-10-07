import type { RoomEvent } from '@spinroom/contracts';
import { channels } from '@spinroom/contracts';
import type { Redis } from 'ioredis';

/**
 * Keeps each linked channel's card current with at most one edit per `intervalMs`
 * (PRD: debounce to one edit every 3 s per channel to respect Slack rate limits).
 */
export class CardScheduler {
  private state = new Map<string, { last: number; timer: ReturnType<typeof setTimeout> | null }>();
  constructor(
    private readonly intervalMs: number,
    private readonly run: (key: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Request an update; coalesces bursts into one edit per interval. */
  request(key: string) {
    const st = this.state.get(key) ?? { last: 0, timer: null };
    this.state.set(key, st);
    if (st.timer) return;
    const wait = Math.max(0, st.last + this.intervalMs - this.now());
    st.timer = setTimeout(() => {
      st.timer = null;
      st.last = this.now();
      void this.run(key).catch(() => {});
    }, wait);
  }

  stop() {
    for (const s of this.state.values()) if (s.timer) clearTimeout(s.timer);
    this.state.clear();
  }
}

const CARD_EVENTS = new Set<RoomEvent['type']>(['spin.started', 'spin.ended', 'votes.changed', 'booth.changed', 'room.status_changed', 'dj_queue.changed']);

/** Subscribe to the internal event stream (same pub/sub the API publishes to). */
export async function subscribeRoomEvents(sub: Redis, onEvent: (roomId: string, ev: RoomEvent) => void) {
  await sub.psubscribe(channels.roomPattern);
  sub.on('pmessage', (_p, channel, message) => {
    const roomId = channel.slice('events:room:'.length);
    try {
      const ev = JSON.parse(message) as RoomEvent;
      onEvent(roomId, ev);
    } catch {
      /* ignore */
    }
  });
}

export const isCardEvent = (ev: RoomEvent) => CARD_EVENTS.has(ev.type);

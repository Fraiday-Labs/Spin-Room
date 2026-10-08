import { RoomEventSchema, TIMING, type RoomEvent, type RoomSnapshot } from '@spinroom/contracts';
import { applyEvent } from './state.js';

/** Minimal WebSocket surface shared by browsers and the `ws` package. */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveRoomOptions {
  /**
   * ws(s)://host/v1/rooms/{slug}/live, or a function resolving it before each (re)connect
   * (the web app fetches a one-time ticket when the socket lives on another origin).
   */
  url: string | (() => Promise<string>);
  /** Create a socket (browser: `(u) => new WebSocket(u)`; Node: `ws` with auth headers). */
  connect: (url: string) => WsLike;
  myUserId?: string | null;
  onSnapshot?: (s: RoomSnapshot) => void;
  onEvent?: (e: RoomEvent, s: RoomSnapshot | null) => void;
  onStatus?: (s: LiveStatus) => void;
  /** Reconnect backoff bounds (PRD: 1 s to 30 s). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Server clock offset updates from socket pings. */
  onPong?: (rttMs: number, offsetMs: number) => void;
}

/**
 * A live room connection: applies events to a snapshot, detects `seq` gaps and asks for
 * a fresh `room.snapshot`, reconnects with exponential backoff.
 */
export class LiveRoom {
  snapshot: RoomSnapshot | null = null;
  status: LiveStatus = 'connecting';
  private ws: WsLike | null = null;
  private backoff: number;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: LiveRoomOptions) {
    this.backoff = o.minBackoffMs ?? 1000;
    this.open();
  }

  private setStatus(s: LiveStatus) {
    this.status = s;
    this.o.onStatus?.(s);
  }

  private open() {
    if (this.stopped) return;
    if (typeof this.o.url === 'string') {
      this.attach(this.o.url);
      return;
    }
    this.o.url().then(
      (u) => this.attach(u),
      () => this.retry(),
    );
  }

  private retry() {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    const wait = this.backoff * (0.8 + Math.random() * 0.4);
    this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 30_000);
    this.timer = setTimeout(() => this.open(), wait);
  }

  private attach(url: string) {
    if (this.stopped) return;
    const ws = this.o.connect(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = this.o.minBackoffMs ?? 1000;
      this.setStatus('open');
      this.pingTimer = setInterval(() => this.ping(), TIMING.clockPingMs);
      this.ping();
    };
    ws.onmessage = (m) => this.handle(typeof m.data === 'string' ? m.data : String(m.data));
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.ws = null;
      // 4401/4403/4404: auth or access problems — don't hammer the server.
      if (this.stopped || ev.code === 4401 || ev.code === 4403 || ev.code === 4404) {
        this.setStatus('closed');
        return;
      }
      this.retry();
    };
  }

  private ping() {
    this.send({ type: 'ping', t: Date.now() });
  }

  private send(msg: unknown) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  resync() {
    this.send({ type: 'resync' });
  }

  /**
   * Apply a local change the server confirmed but doesn't broadcast (e.g. my own vote:
   * `votes.changed` carries only aggregates, FR-V6).
   */
  patch(fn: (s: RoomSnapshot) => RoomSnapshot) {
    if (!this.snapshot) return;
    this.snapshot = fn(this.snapshot);
    this.o.onSnapshot?.(this.snapshot);
  }

  private handle(raw: string) {
    let msg: { type?: string; t?: number; serverNow?: number; seq?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'pong' && typeof msg.t === 'number' && typeof msg.serverNow === 'number') {
      const now = Date.now();
      const rtt = now - msg.t;
      this.o.onPong?.(rtt, msg.serverNow + rtt / 2 - now);
      return;
    }
    if (msg.type === 'error') return;
    const parsed = RoomEventSchema.safeParse(msg);
    if (!parsed.success) return;
    const ev = parsed.data;
    if (ev.type === 'room.snapshot') {
      this.snapshot = ev.snapshot;
      this.o.onSnapshot?.(ev.snapshot);
      this.o.onEvent?.(ev, this.snapshot);
      return;
    }
    if (!this.snapshot) return;
    if (ev.seq <= this.snapshot.seq) return; // duplicate / already applied
    if (ev.seq !== this.snapshot.seq + 1) {
      // Missed an event: ask for a fresh snapshot (PRD realtime rules).
      this.resync();
      return;
    }
    this.snapshot = applyEvent(this.snapshot, ev, this.o.myUserId ?? null);
    this.o.onEvent?.(ev, this.snapshot);
    this.o.onSnapshot?.(this.snapshot);
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close(1000, 'bye');
    this.setStatus('closed');
  }
}

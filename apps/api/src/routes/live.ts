import { ClientMessageSchema, channels, SpinroomError, type RoomEvent } from '@spinroom/contracts';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { authenticate } from '../http/auth.js';
import { assertCanView, ensureMember, roomBySlug } from '../rooms/access.js';
import { redeemLiveTicket } from '../rooms/live-ticket.js';

interface Conn {
  ws: WebSocket;
  userId: string | null;
  isMod: boolean;
}

/**
 * WebSocket `/v1/rooms/{slug}/live`: `room.snapshot` on connect, then every room event
 * fanned out from Redis pub/sub. Clients that miss a `seq` send `{type:"resync"}`.
 */
export function registerLive(app: FastifyInstance, ctx: AppContext) {
  const byRoom = new Map<string, Set<Conn>>();
  let subscribed = false;

  async function ensureSubscribed() {
    if (subscribed) return;
    subscribed = true;
    await ctx.sub.psubscribe(channels.roomPattern);
    ctx.sub.on('pmessage', (_p, channel, message) => {
      const roomId = channel.slice('events:room:'.length);
      const conns = byRoom.get(roomId);
      if (!conns?.size) return;
      let ev: RoomEvent;
      try {
        ev = JSON.parse(message) as RoomEvent;
      } catch {
        return;
      }
      for (const c of conns) {
        if (c.ws.readyState !== 1) continue;
        c.ws.send(message);
        // A kicked member's sockets close after the notice is delivered.
        if (ev.type === 'user.notice' && ev.kind === 'kicked' && ev.userId === c.userId) c.ws.close(4403, 'kicked');
      }
    });
  }

  const allowedOrigins = new Set([
    ctx.cfg.PUBLIC_ORIGIN,
    ...ctx.cfg.WEB_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ]);

  app.get<{ Params: { slug: string }; Querystring: { ticket?: string } }>('/v1/rooms/:slug/live', { websocket: true }, async (socket, req) => {
    const ws = socket as unknown as WebSocket;
    let conn: Conn | null = null;
    let roomId: string | null = null;
    try {
      // Browsers always send Origin; refuse pages we don't serve (cross-site socket hijacking).
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new SpinroomError('origin_rejected', 'Origin not allowed');
      await ensureSubscribed();
      const room = await roomBySlug(ctx, req.params.slug);
      const ticket = req.query.ticket;
      let auth;
      if (ticket) {
        auth = await redeemLiveTicket(ctx, ticket, room.id);
        if (!auth) throw new SpinroomError('unauthenticated', 'Live ticket expired or already used');
      } else {
        auth = await authenticate(ctx, req).catch(() => null);
      }
      const member = await assertCanView(ctx, room, auth?.userId ?? null);
      roomId = room.id;
      conn = { ws, userId: auth?.userId ?? null, isMod: member?.role === 'owner' || member?.role === 'moderator' };
      // Subscribe before taking the snapshot so no event can fall between them.
      const set = byRoom.get(room.id) ?? new Set();
      set.add(conn);
      byRoom.set(room.id, set);
      if (auth) {
        const m = await ensureMember(ctx, room, auth.userId);
        await ctx.services.rooms.exec(room.id, { type: 'connect', userId: auth.userId, role: m.role });
      }
      const sendSnapshot = async () => {
        const snapshot = await ctx.services.rooms.snapshot(room, conn!.userId);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'room.snapshot', seq: snapshot.seq, roomId: room.id, at: ctx.clock.now(), snapshot }));
      };
      await sendSnapshot();
      ws.on('message', (data) => {
        let parsed;
        try {
          parsed = ClientMessageSchema.safeParse(JSON.parse(String(data)));
        } catch {
          return;
        }
        if (!parsed.success) return;
        if (parsed.data.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: parsed.data.t, serverNow: ctx.clock.now() }));
        else if (parsed.data.type === 'resync') void sendSnapshot().catch(() => {});
      });
    } catch (e) {
      const code = e instanceof SpinroomError ? (e.status === 404 ? 4404 : e.status === 401 ? 4401 : 4403) : 1011;
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', code: e instanceof SpinroomError ? e.code : 'internal', message: (e as Error).message }));
        ws.close(code, 'error');
      }
      if (conn && roomId) byRoom.get(roomId)?.delete(conn);
      return;
    }
    ws.on('close', () => {
      if (!conn || !roomId) return;
      byRoom.get(roomId)?.delete(conn);
      if (conn.userId) void ctx.services.rooms.exec(roomId, { type: 'disconnect', userId: conn.userId }).catch(() => {});
    });
  });
}

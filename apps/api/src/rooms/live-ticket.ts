import type { AppContext } from '../context.js';
import type { AuthInfo } from '../http/auth.js';
import { sha256 } from '../lib/crypto.js';

/**
 * One-time tickets for the live socket. The web app is served from another origin than the
 * API in split hosting (static web on a CDN, API in a container), so the WebSocket can't carry
 * the session cookie; it asks for a ticket over the (proxied, same-origin) REST API instead.
 */
export const LIVE_TICKET_TTL_MS = 30_000;

export function liveTicketKey(ticket: string): string {
  return `wsticket:${sha256(ticket)}`;
}

/** Consume a ticket (single use). Returns null when unknown, expired, used, or for another room. */
export async function redeemLiveTicket(ctx: AppContext, ticket: string, roomId: string): Promise<AuthInfo | null> {
  const raw = await ctx.redis.getdel(liveTicketKey(ticket));
  if (!raw) return null;
  const v = JSON.parse(raw) as { auth: AuthInfo; roomId: string };
  return v.roomId === roomId ? v.auth : null;
}

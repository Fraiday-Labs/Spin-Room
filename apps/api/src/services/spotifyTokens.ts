import { SpinroomError } from '@spinroom/contracts';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { spotifyTokens } from '../db/schema.js';
import { SpotifyApiError, type SpotifyTokenSet } from '../spotify/gateway.js';

const SKEW_MS = 60_000;

/**
 * Stores Spotify tokens sealed at rest and refreshes them server-side.
 * Access tokens only leave the API for the user's own speaker page.
 */
export function createSpotifyTokenService(ctx: AppContext) {
  async function save(userId: string, clientId: string, t: SpotifyTokenSet) {
    const row = {
      userId,
      clientId,
      accessTokenEnc: ctx.sealer.seal(t.accessToken),
      refreshTokenEnc: ctx.sealer.seal(t.refreshToken),
      expiresAt: t.expiresAt,
      scopes: t.scope,
    };
    await ctx.db.insert(spotifyTokens).values(row).onConflictDoUpdate({ target: spotifyTokens.userId, set: row });
  }

  async function read(userId: string) {
    return ctx.db.query.spotifyTokens.findFirst({ where: eq(spotifyTokens.userId, userId) });
  }

  async function get(userId: string): Promise<{ accessToken: string; expiresAt: number }> {
    let row = await read(userId);
    if (!row) throw new SpinroomError('spotify_auth_failed', 'Connect Spotify first');
    if (row.expiresAt - SKEW_MS > ctx.clock.now()) return { accessToken: ctx.sealer.open(row.accessTokenEnc), expiresAt: row.expiresAt };

    // Refresh tokens rotate, so only one refresh per user may run at a time.
    const lockKey = `lock:sptok:${userId}`;
    for (let i = 0; i < 50; i++) {
      const got = await ctx.redis.set(lockKey, '1', 'PX', 10_000, 'NX');
      if (got) {
        try {
          row = await read(userId);
          if (row && row.expiresAt - SKEW_MS > ctx.clock.now()) return { accessToken: ctx.sealer.open(row.accessTokenEnc), expiresAt: row.expiresAt };
          const t = await ctx.spotify.refresh({ clientId: row!.clientId, refreshToken: ctx.sealer.open(row!.refreshTokenEnc) });
          await save(userId, row!.clientId, t);
          return { accessToken: t.accessToken, expiresAt: t.expiresAt };
        } catch (e) {
          if (e instanceof SpotifyApiError && e.status === 400) throw new SpinroomError('spotify_auth_failed', 'Spotify session expired — reconnect Spotify');
          throw e;
        } finally {
          await ctx.redis.del(lockKey);
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new SpinroomError('spotify_error', 'Timed out refreshing Spotify token');
  }

  return { save, get, async remove(userId: string) { await ctx.db.delete(spotifyTokens).where(eq(spotifyTokens.userId, userId)); } };
}
export type SpotifyTokenService = ReturnType<typeof createSpotifyTokenService>;

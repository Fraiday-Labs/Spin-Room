import { ApiError, SpinroomClient } from '@spinroom/sdk';
import { hmac } from '@spinroom/db';
import type { SlackConfig } from './config.js';

/**
 * Per-user Spinroom access for Slack users: the service exchanges a linked Slack identity
 * for a short-lived user token (it never holds Spotify tokens).
 */
export function createSpinroomAccess(cfg: SlackConfig) {
  const cache = new Map<string, { token: string; expiresAt: number; userId: string }>();
  const service = new SpinroomClient({ baseUrl: cfg.apiUrl, authorization: () => `Service ${cfg.serviceSecret}` });

  async function tokenFor(teamId: string, slackUserId: string) {
    const key = `${teamId}:${slackUserId}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt - 30_000 > Date.now()) return hit;
    try {
      const r = await service.call('auth.tokenExchange', { body: { grant: 'slack', teamId, slackUserId } });
      const v = { token: r.accessToken, expiresAt: r.expiresAt, userId: r.userId };
      cache.set(key, v);
      return v;
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'not_member' || e.code === 'unauthenticated')) return null;
      throw e;
    }
  }

  return {
    /** A client acting as this Slack user, or null if they haven't connected Spinroom. */
    async client(teamId: string, slackUserId: string): Promise<{ client: SpinroomClient; userId: string } | null> {
      const t = await tokenFor(teamId, slackUserId);
      if (!t) return null;
      return {
        client: new SpinroomClient({ baseUrl: cfg.apiUrl, surface: 'slack', getToken: async () => (await tokenFor(teamId, slackUserId))?.token ?? null }),
        userId: t.userId,
      };
    },
    /** Signed "Connect Spinroom" link (verified by the API, valid 15 minutes). */
    connectUrl(teamId: string, slackUserId: string) {
      const exp = Date.now() + 15 * 60_000;
      const sig = hmac(cfg.serviceSecret, `slack|${teamId}|${slackUserId}|${exp}`);
      return `${cfg.publicUrl}/slack/link?${new URLSearchParams({ team: teamId, user: slackUserId, exp: String(exp), sig })}`;
    },
    forget(teamId: string, slackUserId: string) {
      cache.delete(`${teamId}:${slackUserId}`);
    },
  };
}
export type SpinroomAccess = ReturnType<typeof createSpinroomAccess>;

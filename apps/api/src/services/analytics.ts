import type { AppContext } from '../context.js';
import { analyticsEvents } from '../db/schema.js';
import { newId } from '../lib/ids.js';

export type AnalyticsName =
  | 'login'
  | 'spotify_setup_failed'
  | 'room_created'
  | 'room_closed'
  | 'room_deleted'
  | 'room_joined'
  | 'speaker_started'
  | 'join_to_audio'
  | 'drift_sample'
  | 'vote_cast'
  | 'dj_turn_taken'
  | 'avatar_imported';

/** Product analytics events behind the PRD success metrics. Fire-and-forget. */
export function createAnalytics(ctx: AppContext) {
  return {
    track(name: AnalyticsName, p: { userId?: string | null; roomId?: string | null; props?: Record<string, unknown> } = {}) {
      ctx.db
        .insert(analyticsEvents)
        .values({ id: newId(), name, userId: p.userId ?? null, roomId: p.roomId ?? null, props: p.props ?? {}, at: ctx.clock.now() })
        .catch((e) => ctx.log.warn({ err: e, name }, 'analytics insert failed'));
    },
  };
}
export type Analytics = ReturnType<typeof createAnalytics>;

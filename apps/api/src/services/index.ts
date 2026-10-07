import type { AppContext } from '../context.js';
import { createAnalytics } from './analytics.js';
import { createSessionService } from './sessions.js';
import { createSpotifyTokenService } from './spotifyTokens.js';
import { createUserService } from './users.js';
import { RoomRuntime } from '../rooms/runtime.js';

/** Room lifecycle hooks other services call into (implemented by the room runtime). */
export interface RoomHooks {
  onProfileChanged(userId: string): Promise<void>;
  onAccountDeleted(userId: string): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export function createServices(ctx: AppContext) {
  return {
    rooms: new RoomRuntime(ctx),
    users: createUserService(ctx),
    sessions: createSessionService(ctx),
    spotifyTokens: createSpotifyTokenService(ctx),
    analytics: createAnalytics(ctx),
  };
}
export type Services = ReturnType<typeof createServices>;

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { ManualClock, type Clock } from '../src/lib/clock.js';
import { createRedis } from '../src/lib/redis.js';
import type { AppContext } from '../src/context.js';
import type { SpotifyGateway } from '../src/spotify/gateway.js';

let migrated: Promise<void> | null = null;

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  clock: Clock;
  close(): Promise<void>;
}

const TABLES = [
  'users', 'spotify_tokens', 'sessions', 'rooms', 'room_members', 'invites', 'crate_items', 'dj_queue', 'booth_slots', 'spins', 'votes',
  'chat_messages', 'slack_installs', 'slack_links', 'identity_links', 'api_tokens', 'oauth_clients', 'speakers', 'avatar_reports', 'blobs',
  'analytics_events', 'deletion_requests',
];

export async function createTestApp(opts: { cfg?: Partial<Config>; spotify?: SpotifyGateway; clock?: Clock } = {}): Promise<TestApp> {
  const cfg = loadConfig(process.env, { NODE_ENV: 'test', ...opts.cfg });
  const { db, close } = createDb(cfg.DATABASE_URL);
  migrated ??= runMigrations(db);
  await migrated;
  await db.execute(sql.raw(`TRUNCATE ${TABLES.join(', ')}`));
  await db.execute(sql.raw(`DELETE FROM avatars WHERE kind <> 'preset'`));
  const redis = createRedis(cfg.REDIS_URL);
  const sub = createRedis(cfg.REDIS_URL);
  await redis.flushdb();
  const { app, ctx } = await buildApp({ cfg, db, redis, sub, ...(opts.clock ? { clock: opts.clock } : {}), ...(opts.spotify ? { spotify: opts.spotify } : {}) });
  await ctx.services.rooms?.start?.();
  await app.ready();
  return {
    app,
    ctx,
    db,
    clock: ctx.clock,
    async close() {
      await ctx.services.rooms?.stop?.();
      await app.close();
      redis.disconnect();
      sub.disconnect();
      await close();
    },
  };
}

export { ManualClock };

/** A signed-in test user with helpers that attach bearer auth. */
export interface TestUser {
  id: string;
  token: string;
  name: string;
  req(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
}

export async function login(t: TestApp, spotifyUserId: string, opts: { premium?: boolean; displayName?: string; surface?: string } = {}): Promise<TestUser> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/fake/login',
    payload: { spotifyUserId, premium: opts.premium ?? true, ...(opts.displayName ? { displayName: opts.displayName } : {}) },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const json = res.json();
  return {
    id: json.me.id,
    token: json.accessToken,
    name: json.me.displayName,
    req: (method, url, body, headers = {}) =>
      t.app.inject({
        method: method as 'GET',
        url,
        headers: { authorization: `Bearer ${json.accessToken}`, ...(opts.surface ? { 'x-spinroom-surface': opts.surface } : {}), ...headers },
        ...(body !== undefined ? { payload: body as object } : {}),
      }),
  };
}

export function cookiesFrom(res: LightMyRequestResponse): Record<string, string> {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}

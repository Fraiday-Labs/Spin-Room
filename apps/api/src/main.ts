import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createRedis } from './lib/redis.js';

const cfg = loadConfig();
const { db, close } = createDb(cfg.DATABASE_URL, cfg.DB_POOL_MAX);
if (process.env.MIGRATE_ON_BOOT !== '0') await runMigrations(db);
const redis = createRedis(cfg.REDIS_URL);
const sub = createRedis(cfg.REDIS_URL);
const { app, ctx } = await buildApp({ cfg, db, redis, sub });

await ctx.services.rooms?.start?.();
await app.listen({ host: cfg.HOST, port: cfg.PORT });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    app.log.info({ sig }, 'shutting down');
    await ctx.services.rooms?.stop?.();
    await app.close();
    redis.disconnect();
    sub.disconnect();
    await close();
    process.exit(0);
  });
}

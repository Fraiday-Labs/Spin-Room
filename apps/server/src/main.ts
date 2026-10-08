import { refreshAvatars } from '../../api/src/avatars/rebuild.js';
import { loadConfig } from '../../api/src/config.js';
import { createDb } from '../../api/src/db/client.js';
import { runMigrations } from '../../api/src/db/migrate.js';
import { createAllInOne } from './server.js';

const cfg = loadConfig();
const { db, close } = createDb(cfg.DATABASE_URL, cfg.DB_POOL_MAX);
if (process.env.MIGRATE_ON_BOOT !== '0') await runMigrations(db);
const server = await createAllInOne({ cfg, db });
await server.start();
server.app.log.info(`Spinroom (API + MCP + Slack) on :${cfg.PORT}`);
// Uploads saved by an older sheet builder are rebuilt in the background.
void refreshAvatars(server.ctx, (msg, err) => server.app.log.warn({ err }, msg)).then((n) => n && server.app.log.info(`rebuilt ${n} avatar(s)`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    server.app.log.info({ sig }, 'shutting down');
    await server.stop();
    await close();
    process.exit(0);
  });
}

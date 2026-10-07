import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createDb, type Db } from './client.js';
import { seedPresetAvatars } from './presets.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await seedPresetAvatars(db);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const { db, close } = createDb(cfg.DATABASE_URL);
  await runMigrations(db);
  await close();
  console.log('migrations applied');
}

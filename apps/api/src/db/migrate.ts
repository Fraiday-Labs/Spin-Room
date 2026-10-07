import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';
import { seedPresetAvatars } from './presets.js';

/** Works from src/db (tsx) and from the bundled dist/main.js. */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ??
  [new URL('../../drizzle', import.meta.url), new URL('../drizzle', import.meta.url)]
    .map((u) => fileURLToPath(u))
    .find((p) => existsSync(`${p}/meta/_journal.json`)) ??
  fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await seedPresetAvatars(db);
}

import { loadConfig } from '../config.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';

const cfg = loadConfig();
const { db, close } = createDb(cfg.DATABASE_URL);
await runMigrations(db);
await close();
console.log('migrations applied');

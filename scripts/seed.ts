/**
 * Seed a local database with three fake users and two rooms (SPOTIFY_MODE=fake).
 * Usage: pnpm seed   (uses DATABASE_URL / REDIS_URL from .env or defaults)
 */
import { buildApp } from '../apps/api/src/app.js';
import { loadConfig } from '../apps/api/src/config.js';
import { createDb } from '../apps/api/src/db/client.js';
import { runMigrations } from '../apps/api/src/db/migrate.js';
import { createRedis } from '../apps/api/src/lib/redis.js';

const cfg = loadConfig(process.env, { SPOTIFY_MODE: 'fake', NODE_ENV: 'development', RUN_ROOM_ENGINE: false, LOG_LEVEL: 'warn' });
const { db, close } = createDb(cfg.DATABASE_URL);
await runMigrations(db);
const redis = createRedis(cfg.REDIS_URL);
const sub = createRedis(cfg.REDIS_URL);
const { app } = await buildApp({ cfg, db, redis, sub });
await app.ready();

async function call(token: string | null, method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload ? { payload: payload as object } : {}) });
  if (res.statusCode >= 400 && res.json().code !== 'slug_taken') throw new Error(`${method} ${url}: ${res.body}`);
  return res.json();
}

const people = [
  { id: 'alice', name: 'Alice', tracks: ['Neon Tide', 'Booth Lights', 'Pixel Rain', 'Equalizer'] },
  { id: 'bob', name: 'Bob', tracks: ['Crate Digger', 'Amber Marquee', 'Hype Train'] },
  { id: 'carol', name: 'Carol', tracks: ['Cyan Skyline', 'Magenta Hour', 'Glow Stick Waltz'] },
];
const tokens: Record<string, string> = {};
for (const p of people) {
  const r = await call(null, 'POST', '/v1/auth/fake/login', { spotifyUserId: p.id, displayName: p.name, premium: true });
  tokens[p.id] = r.accessToken;
}

const lounge = await call(tokens.alice!, 'POST', '/v1/rooms', { name: 'Late Night Lounge', slug: 'late-night-lounge', description: 'Synths, neon and slow grooves.' });
const chill = await call(tokens.bob!, 'POST', '/v1/rooms', { name: 'Code & Chill', slug: 'code-and-chill', description: 'Focus music for the team.', visibility: 'invite_only' });
for (const p of people) {
  await call(tokens[p.id]!, 'POST', '/v1/rooms/late-night-lounge/join');
  for (const t of p.tracks) await call(tokens[p.id]!, 'POST', '/v1/rooms/late-night-lounge/crate', { query: t });
}
if (chill.invite) await call(tokens.carol!, 'POST', `/v1/invites/${chill.invite.token}/accept`);
console.log('seeded users alice, bob, carol; rooms late-night-lounge (public) and code-and-chill (invite-only)');
if (chill.invite) console.log(`Code & Chill invite: ${chill.invite.url}`);
void lounge;
await app.close();
redis.disconnect();
sub.disconnect();
await close();

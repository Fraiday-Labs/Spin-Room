import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Clock } from './lib/clock.js';
import type { Sealer } from './lib/crypto.js';
import type { Jwt } from './lib/jwt.js';
import type { SpotifyGateway } from './spotify/gateway.js';
import type { Storage } from './lib/storage.js';
import type { Services } from './services/index.js';

/** Everything handlers need, injected once at startup (and swapped in tests). */
export interface AppContext {
  cfg: Config;
  db: Db;
  redis: Redis;
  /** Dedicated connection for pub/sub subscriptions. */
  sub: Redis;
  clock: Clock;
  sealer: Sealer;
  jwt: Jwt;
  spotify: SpotifyGateway;
  storage: Storage;
  log: FastifyBaseLogger;
  services: Services;
}

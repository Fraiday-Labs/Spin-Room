import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { AVATAR_LIMITS } from '@spinroom/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import type { Db } from './db/client.js';
import { registerErrorHandling } from './http/errors.js';
import { registerRoutes } from './http/router.js';
import { systemClock, type Clock } from './lib/clock.js';
import { createAesSealer } from './lib/crypto.js';
import { Jwt } from './lib/jwt.js';
import { FsStorage, S3Storage, type Storage } from './lib/storage.js';
import { registerAssetRoutes } from './routes/assets.js';
import { authHandlers } from './routes/auth.js';
import { avatarHandlers } from './routes/avatars.js';
import { meHandlers } from './routes/me.js';
import { playHandlers } from './routes/play.js';
import { registerLive } from './routes/live.js';
import { roomHandlers } from './routes/rooms.js';
import { tokenHandlers } from './routes/tokens.js';
import { oauthHandlers, registerOAuth } from './routes/oauth.js';
import { createServices } from './services/index.js';
import { FakeSpotifyGateway } from './spotify/fake.js';
import type { SpotifyGateway } from './spotify/gateway.js';
import { RealSpotifyGateway } from './spotify/real.js';

export interface BuildOptions {
  cfg: Config;
  db: Db;
  redis: Redis;
  sub: Redis;
  clock?: Clock;
  spotify?: SpotifyGateway;
  storage?: Storage;
}

export function createStorage(cfg: Config): Storage {
  if (cfg.STORAGE_DRIVER === 's3') {
    if (!cfg.S3_ENDPOINT || !cfg.S3_BUCKET || !cfg.S3_ACCESS_KEY_ID || !cfg.S3_SECRET_ACCESS_KEY) throw new Error('S3_* settings are required for STORAGE_DRIVER=s3');
    return new S3Storage({
      endpoint: cfg.S3_ENDPOINT,
      region: cfg.S3_REGION,
      bucket: cfg.S3_BUCKET,
      accessKeyId: cfg.S3_ACCESS_KEY_ID,
      secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
      publicBaseUrl: cfg.ASSET_BASE_URL,
    });
  }
  return new FsStorage(cfg.STORAGE_DIR, cfg.ASSET_BASE_URL);
}

export async function buildApp(o: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: o.cfg.NODE_ENV === 'test' ? false : { level: o.cfg.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  const ctx = {
    cfg: o.cfg,
    db: o.db,
    redis: o.redis,
    sub: o.sub,
    clock: o.clock ?? systemClock,
    sealer: createAesSealer(o.cfg.ENCRYPTION_KEY),
    jwt: new Jwt(o.cfg.SESSION_SECRET),
    spotify:
      o.spotify ??
      (o.cfg.SPOTIFY_MODE === 'fake'
        ? new FakeSpotifyGateway(o.redis)
        : new RealSpotifyGateway({ accountsUrl: o.cfg.SPOTIFY_ACCOUNTS_URL, apiUrl: o.cfg.SPOTIFY_API_URL })),
    storage: o.storage ?? createStorage(o.cfg),
    log: app.log,
  } as AppContext;
  ctx.services = createServices(ctx);

  await app.register(cookie);
  // OAuth token/registration endpoints take form posts.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  await app.register(multipart, { limits: { fileSize: AVATAR_LIMITS.uploadMaxBytes, files: 2, fields: 10 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Security headers. The web app's CSP is set by its host; API responses are JSON only.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (!reply.getHeader('content-security-policy')) reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  });

  registerErrorHandling(app);
  registerRoutes(app, ctx, { ...authHandlers, ...meHandlers, ...roomHandlers, ...playHandlers, ...avatarHandlers, ...tokenHandlers, ...oauthHandlers });
  registerOAuth(app, ctx);
  registerLive(app, ctx);
  registerAssetRoutes(app, ctx);
  app.get('/healthz', async () => ({ ok: true }));

  return { app, ctx };
}

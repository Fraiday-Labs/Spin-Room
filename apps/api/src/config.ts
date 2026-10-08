import { z } from 'zod';

const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes'].includes(v.toLowerCase())));

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8080),
  /** Public origin users reach (web + /v1 share an origin behind the ingress or Vite proxy). */
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  /**
   * Extra comma-separated web origins allowed to open the live socket (PUBLIC_ORIGIN always is),
   * e.g. a Vercel preview domain when the web app and API are hosted apart.
   */
  WEB_ORIGINS: z.string().default(''),
  DATABASE_URL: z.string().default('postgres://spinroom:spinroom@localhost:5432/spinroom'),
  /** Postgres pool size (keep the sum across services under the database's connection limit). */
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  REDIS_URL: z.string().default('redis://localhost:6379/0'),
  /** HMAC key for session JWTs (≥ 32 chars). */
  SESSION_SECRET: z.string().min(32).default('dev-session-secret-change-me-0123456789abcdef'),
  /** 32-byte key, base64, for sealing Spotify/Slack tokens at rest. */
  ENCRYPTION_KEY: z.string().default('ZGV2LWVuY3J5cHRpb24ta2V5LWNoYW5nZS1tZS0zMmI='),
  SPOTIFY_MODE: z.enum(['real', 'fake']).default('fake'),
  /** Option A (local development only): a shared Client ID used when a user has none. */
  SPOTIFY_DEV_CLIENT_ID: z.string().optional(),
  SPOTIFY_ACCOUNTS_URL: z.string().default('https://accounts.spotify.com'),
  SPOTIFY_API_URL: z.string().default('https://api.spotify.com/v1'),
  SERVICE_SECRET_SLACK: z.string().min(16).default('dev-slack-service-secret'),
  SERVICE_SECRET_MCP: z.string().min(16).default('dev-mcp-service-secret'),
  /** Public URL of the MCP resource (audience for MCP OAuth tokens). */
  MCP_RESOURCE_URL: z.string().default('http://127.0.0.1:8090/mcp'),
  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  STORAGE_DIR: z.string().default('.data/blobs'),
  /** URL prefix for stored assets (CDN in production). */
  ASSET_BASE_URL: z.string().default('/v1/assets'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Comma-separated Spotify user IDs that are Spinroom admins. */
  ADMIN_SPOTIFY_IDS: z.string().default(''),
  COOKIE_SECURE: bool.default(false),
  /** Image-safety check for custom avatars: manual review queue, or auto-approve (dev only). */
  AVATAR_SAFETY: z.enum(['manual', 'auto_approve']).default('manual'),
  /** Run the room runtime timers in this process (disable for read-only replicas). */
  RUN_ROOM_ENGINE: bool.default(true),
  /** Staging only: allow SPOTIFY_MODE=fake with NODE_ENV=production (smoke tests of a deploy). */
  ALLOW_FAKE_SPOTIFY: bool.default(false),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<Config> = {}): Config {
  // Empty values (e.g. `SESSION_SECRET=` copied from .env.example) mean "use the default".
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const cfg = ConfigSchema.parse({ ...set, ...overrides });
  if (cfg.NODE_ENV === 'production') {
    if (cfg.SESSION_SECRET.startsWith('dev-')) throw new Error('SESSION_SECRET must be set in production');
    if (cfg.ENCRYPTION_KEY === ConfigSchema.shape.ENCRYPTION_KEY.parse(undefined)) throw new Error('ENCRYPTION_KEY must be set in production');
    if (cfg.SPOTIFY_MODE === 'fake' && !cfg.ALLOW_FAKE_SPOTIFY) throw new Error('SPOTIFY_MODE=fake is not allowed in production');
    if (cfg.AVATAR_SAFETY === 'auto_approve') throw new Error('AVATAR_SAFETY=auto_approve is not allowed in production');
  }
  return cfg;
}

export function callbackUrl(cfg: Config): string {
  return `${cfg.PUBLIC_ORIGIN}/v1/auth/spotify/callback`;
}

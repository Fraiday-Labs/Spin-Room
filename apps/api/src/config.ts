import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes'].includes(v.toLowerCase())));

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8080),
  /** Public origin users reach (web + /v1 share an origin behind the ingress or Vite proxy). */
  PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  DATABASE_URL: z.string().default('postgres://spinroom:spinroom@localhost:5432/spinroom'),
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
  /** Run the room runtime timers in this process (disable for read-only replicas). */
  RUN_ROOM_ENGINE: bool.default(true),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<Config> = {}): Config {
  const cfg = ConfigSchema.parse({ ...env, ...overrides });
  if (cfg.NODE_ENV === 'production') {
    if (cfg.SESSION_SECRET.startsWith('dev-')) throw new Error('SESSION_SECRET must be set in production');
    if (cfg.ENCRYPTION_KEY === ConfigSchema.shape.ENCRYPTION_KEY.parse(undefined)) throw new Error('ENCRYPTION_KEY must be set in production');
    if (cfg.SPOTIFY_MODE === 'fake') throw new Error('SPOTIFY_MODE=fake is not allowed in production');
  }
  return cfg;
}

export function callbackUrl(cfg: Config): string {
  return `${cfg.PUBLIC_ORIGIN}/v1/auth/spotify/callback`;
}

export function slackConfig(raw: Record<string, string | undefined> = process.env) {
  const env = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ''));
  return {
    signingSecret: env.SLACK_SIGNING_SECRET ?? 'dev-slack-signing-secret',
    clientId: env.SLACK_CLIENT_ID ?? 'dev-client-id',
    clientSecret: env.SLACK_CLIENT_SECRET ?? 'dev-client-secret',
    stateSecret: env.SLACK_STATE_SECRET ?? 'dev-slack-state-secret',
    port: Number(env.SLACK_PORT ?? 8070),
    apiUrl: apiOrigin(env.SPINROOM_API_URL),
    publicUrl: (env.SPINROOM_PUBLIC_URL ?? env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173').replace(/\/$/, ''),
    serviceSecret: env.SERVICE_SECRET_SLACK ?? 'dev-slack-service-secret',
    databaseUrl: env.DATABASE_URL ?? 'postgres://spinroom:spinroom@localhost:5432/spinroom',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379/0',
    encryptionKey: env.ENCRYPTION_KEY ?? 'ZGV2LWVuY3J5cHRpb24ta2V5LWNoYW5nZS1tZS0zMmI=',
    /** Test hook: point the Web API client at a fake Slack. */
    slackApiUrl: env.SLACK_API_URL,
    /** Minimum gap between card edits per channel (PRD: one edit per 3 s). */
    cardIntervalMs: Number(env.SLACK_CARD_INTERVAL_MS ?? 3000),
  };
}
export type SlackConfig = ReturnType<typeof slackConfig>;

/** Bot scopes (PRD) plus channels/groups history to count newer messages for card reposts. */
export const BOT_SCOPES = [
  'commands',
  'chat:write',
  'chat:write.public',
  'users:read',
  'channels:read',
  'groups:read',
  'im:write',
  'channels:history',
  'groups:history',
];
export const BASE = '/v1/integrations/slack';

/** The API's base URL; a bare `host:port` (a private-network address) means plain http. */
export function apiOrigin(v: string | undefined): string {
  const u = (v ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
  return /^https?:\/\//.test(u) ? u : `http://${u}`;
}

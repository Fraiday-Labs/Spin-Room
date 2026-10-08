import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { FastifyServerFactory } from 'fastify';
import { buildApp } from '../../api/src/app.js';
import type { Config } from '../../api/src/config.js';
import type { Db } from '../../api/src/db/client.js';
import { createRedis } from '../../api/src/lib/redis.js';
import { mcpConfig } from '../../mcp/src/config.js';
import { createMcpHandler } from '../../mcp/src/remote.js';
import { createSlackApp } from '../../slack/src/app.js';
import { slackConfig } from '../../slack/src/config.js';

export interface AllInOneOptions {
  cfg: Config;
  db: Db;
  /** Environment for the MCP and Slack settings (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/** Paths answered by the MCP server; everything under SLACK_PREFIX goes to Slack. */
const MCP_PATHS = new Set(['/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
const SLACK_PREFIX = '/v1/integrations/slack/';

/**
 * The API, the remote MCP server and the Slack app behind one HTTP server and one port, for
 * hosts that give you a single small instance (free tiers). Fastify serves everything except
 * the MCP and Slack paths, including the live WebSocket. MCP and Slack reach the API over
 * loopback exactly as they would across services, so they keep using only public endpoints.
 */
export async function createAllInOne(o: AllInOneOptions) {
  const env = { ...(o.env ?? process.env) };
  const loopback = `http://127.0.0.1:${o.cfg.PORT}`;
  env.SPINROOM_API_URL ??= loopback;
  env.SERVICE_SECRET_MCP ??= o.cfg.SERVICE_SECRET_MCP;
  env.SERVICE_SECRET_SLACK ??= o.cfg.SERVICE_SECRET_SLACK;
  env.MCP_RESOURCE_URL ??= o.cfg.MCP_RESOURCE_URL;
  env.PUBLIC_ORIGIN ??= o.cfg.PUBLIC_ORIGIN;
  env.ENCRYPTION_KEY ??= o.cfg.ENCRYPTION_KEY;

  const redis = createRedis(o.cfg.REDIS_URL);
  const sub = createRedis(o.cfg.REDIS_URL);
  const slackSub = createRedis(o.cfg.REDIS_URL);

  const mcp = createMcpHandler(mcpConfig(env));
  const slack = createSlackApp(slackConfig(env), { db: o.db, redis, sub: slackSub });

  const route = (fastify: (req: IncomingMessage, res: ServerResponse) => void) => (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?', 1)[0]!;
    if (MCP_PATHS.has(path)) return void mcp.handler(req, res);
    if (path.startsWith(SLACK_PREFIX)) return void slack.requestListener(req, res);
    fastify(req, res);
  };
  const serverFactory: FastifyServerFactory = (handler) => createServer(route(handler));

  const { app, ctx } = await buildApp({ cfg: o.cfg, db: o.db, redis, sub, serverFactory });

  return {
    app,
    ctx,
    mcpSessions: mcp.sessions,
    async start() {
      await ctx.services.rooms?.start?.();
      await slack.attach();
      await app.listen({ host: o.cfg.HOST, port: o.cfg.PORT });
    },
    async stop() {
      for (const s of mcp.sessions.values()) await s.transport.close().catch(() => {});
      await slack.stop();
      await ctx.services.rooms?.stop?.();
      await app.close();
      for (const r of [redis, sub, slackSub]) r.disconnect();
    },
  };
}

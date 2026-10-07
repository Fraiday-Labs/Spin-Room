import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SpinroomClient, type WsLike } from '@spinroom/sdk';
import WebSocket from 'ws';
import { mcpConfig, type McpConfig } from './config.js';
import { createSpinroomServer } from './tools.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => void;
  userId: string;
  apiToken: { token: string; expiresAt: number };
}

/**
 * Remote MCP server (Streamable HTTP) protected by the MCP authorization spec. The bearer
 * token is audience-bound to this resource; it is exchanged at the API for a short-lived
 * API token, so this service never sees Spotify tokens or app-level credentials.
 */
export function createMcpHttpServer(cfg: McpConfig = mcpConfig()) {
  const sessions = new Map<string, Session>();
  const exchangeCache = new Map<string, { token: string; expiresAt: number; userId: string }>();

  async function exchange(bearer: string) {
    const hit = exchangeCache.get(bearer);
    if (hit && hit.expiresAt - 30_000 > Date.now()) return hit;
    const svc = new SpinroomClient({ baseUrl: cfg.apiUrl, authorization: () => `Service ${cfg.serviceSecret}` });
    const r = await svc.call('auth.tokenExchange', { body: { grant: 'mcp', subjectToken: bearer } });
    const v = { token: r.accessToken, expiresAt: r.expiresAt, userId: r.userId };
    exchangeCache.set(bearer, v);
    if (exchangeCache.size > 5000) exchangeCache.delete(exchangeCache.keys().next().value!);
    return v;
  }

  const metadataUrl = () => `${new URL(cfg.resourceUrl).origin}/.well-known/oauth-protected-resource`;
  const unauthorized = (res: ServerResponse, msg: string) => {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${metadataUrl()}"` });
    res.end(JSON.stringify({ error: 'invalid_token', error_description: msg }));
  };

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1024 * 1024) throw new Error('body too large');
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : undefined;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version');
    res.setHeader('access-control-expose-headers', 'mcp-session-id, www-authenticate');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ resource: cfg.resourceUrl, authorization_servers: [cfg.issuer], bearer_methods_supported: ['header'], scopes_supported: ['rooms'], resource_name: 'Spinroom' }));
    }
    if (url.pathname === '/healthz') return void res.writeHead(200).end('ok');
    if (url.pathname !== '/mcp') return void res.writeHead(404).end();

    const authz = req.headers.authorization;
    if (!authz?.startsWith('Bearer ')) return unauthorized(res, 'Sign in required');
    let ex: Awaited<ReturnType<typeof exchange>>;
    try {
      ex = await exchange(authz.slice(7));
    } catch {
      return unauthorized(res, 'Invalid or revoked token');
    }

    try {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      let session = sid ? sessions.get(sid) : undefined;
      if (session && session.userId !== ex.userId) return unauthorized(res, 'Session belongs to another user');
      if (session) session.apiToken = ex;

      if (!session) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send initialize first' }, id: null }));
        }
        const holder = { apiToken: ex };
        const client = new SpinroomClient({ baseUrl: cfg.apiUrl, surface: 'mcp', getToken: () => holder.apiToken.token });
        const { server: mcp, close } = createSpinroomServer({
          client,
          publicUrl: cfg.publicUrl,
          apiUrl: cfg.apiUrl,
          connectLive: (u) => new WebSocket(u, { headers: { authorization: `Bearer ${holder.apiToken.token}` } }) as unknown as WsLike,
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, s);
          },
        });
        const s: Session = {
          transport,
          close,
          userId: ex.userId,
          get apiToken() {
            return holder.apiToken;
          },
          set apiToken(v) {
            holder.apiToken = v;
          },
        };
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          close();
        };
        await mcp.connect(transport);
        session = s;
      }
      await session.transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null }));
      }
    }
  });
  return { server, sessions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = mcpConfig();
  const { server } = createMcpHttpServer(cfg);
  server.listen(cfg.port, cfg.host, () => console.log(`Spinroom MCP on http://${cfg.host}:${cfg.port}/mcp (resource ${cfg.resourceUrl})`));
}

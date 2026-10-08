import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../api/src/config.js';
import { createDb } from '../../api/src/db/client.js';
import { runMigrations } from '../../api/src/db/migrate.js';
import { createAllInOne } from '../src/server.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
const SIGNING = 'test-signing-secret-all-in-one';

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

let base: string;
let server: Awaited<ReturnType<typeof createAllInOne>>;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const cfg = loadConfig(process.env, { NODE_ENV: 'test', PORT: port, HOST: '127.0.0.1', PUBLIC_ORIGIN: base, MCP_RESOURCE_URL: `${base}/mcp` });
  const { db, close } = createDb(cfg.DATABASE_URL, 8);
  closeDb = close;
  await runMigrations(db);
  server = await createAllInOne({ cfg, db, env: { ...process.env, SLACK_SIGNING_SECRET: SIGNING } });
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  await closeDb?.();
});

async function login(id: string) {
  const r = await fetch(`${base}/v1/auth/fake/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spotifyUserId: id, premium: true }),
  });
  expect(r.status).toBe(200);
  const token = ((await r.json()) as J).accessToken as string;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as J };
  };
  return { token, api };
}

describe('all-in-one server (API + MCP + Slack on one port)', () => {
  it('answers the deep health check from Postgres and Redis', async () => {
    const r = await fetch(`${base}/healthz?deep=1`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, db: true, redis: true });
  });

  it('serves REST and the live socket (ticket) through Fastify', async () => {
    const alice = await login(`aio-${randomBytes(3).toString('hex')}`);
    const room = await alice.api('POST', '/v1/rooms', { name: `All in one ${randomBytes(3).toString('hex')}` });
    expect(room.status).toBe(200);
    const slug = room.json.room.slug as string;
    const { json } = await alice.api('POST', `/v1/rooms/${slug}/live-ticket`);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/rooms/${slug}/live?ticket=${json.ticket}`, { headers: { origin: base } });
    const snap = await new Promise<J>((resolve, reject) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m.type === 'room.snapshot' || m.type === 'error') resolve(m);
      });
      ws.on('error', reject);
    });
    ws.close();
    expect(snap.type).toBe('room.snapshot');
    expect(snap.snapshot.me.role).toBe('owner');
  });

  it('serves the remote MCP server with OAuth on the same origin', async () => {
    const r401 = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r401.status).toBe(401);
    expect(r401.headers.get('www-authenticate')).toContain(`${base}/.well-known/oauth-protected-resource`);
    const meta = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as J;
    expect(meta).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as J;

    const redirect = 'http://127.0.0.1:33418/callback';
    const reg = (await (
      await fetch(as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Test agent', redirect_uris: [redirect] }),
      })
    ).json()) as J;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const az = await fetch(
      `${as.authorization_endpoint}?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=s&resource=${encodeURIComponent(`${base}/mcp`)}`,
      { redirect: 'manual' },
    );
    const requestId = new URL(az.headers.get('location')!, base).searchParams.get('request')!;
    const bob = await login(`aio-${randomBytes(3).toString('hex')}`);
    const approved = await bob.api('POST', `/v1/oauth/requests/${requestId}/approve`, { approve: true });
    const code = new URL(approved.json.redirectTo).searchParams.get('code')!;
    const tok = (await (
      await fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }),
      })
    ).json()) as J;

    const mcp = new Client({ name: 'test', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
    const tools = (await mcp.listTools()).tools;
    expect(tools).toHaveLength(17);
    const rooms = await mcp.callTool({ name: 'list_rooms', arguments: {} });
    expect(rooms.isError).toBeFalsy();
    await mcp.close();
  });

  it('routes Slack requests to Bolt, which checks signatures', async () => {
    const url = `${base}/v1/integrations/slack/events`;
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'x' });
    const unsigned = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': `${Math.floor(Date.now() / 1000)}`, 'x-slack-signature': 'v0=bad' },
      body,
    });
    expect(unsigned.status).toBe(401);
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex')}`;
    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
      body,
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('abc123');
  });
});

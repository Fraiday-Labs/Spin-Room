import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { SpinroomClient, type WsLike } from '@spinroom/sdk';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, login, type TestApp } from '../../api/test/helpers.js';
import { createMcpHttpServer } from '../src/http.js';
import { createSpinroomServer, parseRoomArg } from '../src/tools.js';

let t: TestApp;
let closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
  await t?.close();
});

async function startApi(cfg: Record<string, unknown> = {}) {
  t = await createTestApp({ cfg: cfg as never });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (t.app.server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

async function mcpFor(base: string, pat: string) {
  const client = new SpinroomClient({ baseUrl: base, surface: 'mcp', getToken: () => pat });
  const { server, close } = createSpinroomServer({ client, publicUrl: 'https://spinroom.test', connectLive: (u) => new WebSocket(u, { headers: { authorization: `Bearer ${pat}` } }) as unknown as WsLike });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  closers.push(async () => {
    close();
    await mcp.close();
  });
  return mcp;
}

async function pat(u: Awaited<ReturnType<typeof login>>) {
  return (await u.req('POST', '/v1/tokens', { label: 'test' })).json().token as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
type Res = { structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[]; isError?: boolean };
const call = async (mcp: Client, name: string, args: Record<string, unknown>) => (await mcp.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content.map((c) => c.text ?? '').join('\n');

describe('MCP tools (Journey 3)', () => {
  it('exposes all 17 tools, the now-playing resource and the session prompt', async () => {
    const base = await startApi();
    const alice = await login(t, 'alice');
    const mcp = await mcpFor(base, await pat(alice));
    const tools = (await mcp.listTools()).tools.map((x) => x.name).sort();
    expect(tools).toEqual(
      ['chat_send', 'crate_add', 'crate_list', 'crate_move', 'crate_remove', 'create_room', 'dj_queue_join', 'dj_queue_leave', 'invite', 'join_room', 'leave_room', 'list_rooms', 'now_playing', 'room_history', 'search_tracks', 'skip_my_spin', 'vote'].sort(),
    );
    const vote = (await mcp.listTools()).tools.find((x) => x.name === 'vote')!;
    expect(vote.description).toContain('visible to other room members');
    const prompts = await mcp.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['spinroom_session']);
    const p = await mcp.getPrompt({ name: 'spinroom_session', arguments: {} });
    expect(JSON.stringify(p.messages)).toContain('tell me what’s playing');
    const templates = await mcp.listResourceTemplates();
    expect(templates.resourceTemplates[0]!.uriTemplate).toBe('spinroom://room/{slug}/now-playing');
  });

  it('creates, invites, joins, DJs, votes and chats from agents', async () => {
    const base = await startApi();
    const alice = await login(t, 'alice', { displayName: 'Alice' });
    const bob = await login(t, 'bob', { displayName: 'Bob' });
    const a = await mcpFor(base, await pat(alice));
    const b = await mcpFor(base, await pat(bob));

    const created = await call(a, 'create_room', { name: 'Agent Lounge', visibility: 'invite_only' });
    expect(created.isError).toBeFalsy();
    const slug = (created.structuredContent!.room as { slug: string }).slug;
    expect(slug).toBe('agent-lounge');

    const inv = await call(a, 'invite', { room: slug, expires_in: '1d' });
    const inviteUrl = inv.structuredContent!.invite_url as string;
    expect(text(inv)).toContain(inviteUrl);

    // Bob joins by invite link; no speaker → speaker link.
    const joined = await call(b, 'join_room', { room: inviteUrl });
    expect(joined.structuredContent).toMatchObject({ speaker_status: 'off', speaker_url: `https://spinroom.test/r/${slug}?speaker=1` });

    // Alice builds a set and steps up.
    expect(text(await call(a, 'search_tracks', { query: 'neon', limit: 3 }))).toContain('Neon Tide');
    await call(a, 'join_room', { room: slug });
    await call(a, 'crate_add', { room: slug, query: 'Neon Tide' });
    await call(a, 'crate_add', { room: slug, query: 'Booth Lights' });
    const added = await call(a, 'crate_add', { room: slug, query: 'Pixel Rain' });
    expect((added.structuredContent!.tracks as unknown[]).length).toBe(3);
    const moved = await call(a, 'crate_move', { room: slug, from: 3, to: 1 });
    expect(text(moved).split('\n')[0]).toContain('Pixel Rain');
    const removed = await call(a, 'crate_remove', { room: slug, position: 3 });
    expect(text(removed).split('\n').slice(1).join('\n')).not.toContain('Booth Lights');
    const q = await call(a, 'dj_queue_join', { room: slug });
    expect(q.structuredContent).toMatchObject({ booth_slot: 1 });

    const np = await call(b, 'now_playing', { room: slug });
    expect(np.structuredContent).toMatchObject({ dj: 'Alice', status: 'playing', track: { title: 'Pixel Rain' }, queue_length: 0, booth: ['Alice'] });
    expect(text(np)).toMatch(/▶ .*Pixel Rain \(DJ Alice\)/);

    const v = await call(b, 'vote', { room: slug, vote: 'hype' });
    expect(v.structuredContent).toMatchObject({ my_vote: 'hype', counted: false, crowd: { hype: 1 } });
    expect(text(v)).toContain('once your speaker is live');
    expect((await call(b, 'vote', { room: slug, vote: 'hype' })).structuredContent).toMatchObject({ crowd: { hype: 1 } }); // idempotent
    expect((await call(a, 'vote', { room: slug, vote: 'hype' })).isError).toBe(true); // DJ can't vote

    expect((await call(b, 'chat_send', { room: slug, text: 'great pick' })).isError).toBeFalsy();
    expect((await call(a, 'skip_my_spin', { room: slug })).isError).toBeFalsy();
    const hist = await call(a, 'room_history', { room: slug, limit: 5 });
    expect((hist.structuredContent!.spins as { ended: string }[])[1]!.ended).toBe('dj_skip');

    const rooms = await call(b, 'list_rooms', { filter: 'mine' });
    expect(text(rooms)).toContain('agent-lounge');
    expect((await call(a, 'dj_queue_leave', { room: slug })).isError).toBeFalsy();
    expect((await call(b, 'leave_room', { room: slug })).isError).toBeFalsy();
  });

  it('reads and subscribes to the now-playing resource', async () => {
    const base = await startApi();
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob');
    const a = await mcpFor(base, await pat(alice));
    const b = await mcpFor(base, await pat(bob));
    await call(a, 'create_room', { name: 'Res Room' });
    await call(a, 'crate_add', { room: 'res-room', query: 'Neon Tide' });
    await call(a, 'join_room', { room: 'res-room' });
    await call(a, 'dj_queue_join', { room: 'res-room' });
    await call(b, 'join_room', { room: 'res-room' });
    const uri = 'spinroom://room/res-room/now-playing';
    const read = await b.readResource({ uri });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toMatchObject({ track: { title: 'Neon Tide' } });
    const updated = new Promise<string>((resolve) => b.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => resolve(n.params.uri)));
    await b.subscribeResource({ uri });
    await new Promise((r) => setTimeout(r, 300));
    await call(b, 'vote', { room: 'res-room', vote: 'skip' });
    expect(await updated).toBe(uri);
  });

  it('parses room arguments', () => {
    expect(parseRoomArg('https://x.test/invite/inv_abc-1')).toEqual({ invite: 'inv_abc-1' });
    expect(parseRoomArg('https://x.test/r/late-night?speaker=1')).toEqual({ slug: 'late-night' });
    expect(parseRoomArg('Late-Night')).toEqual({ slug: 'late-night' });
  });
});

describe('remote MCP over HTTP with OAuth 2.1', () => {
  it('runs discovery, dynamic registration, PKCE consent, token use, refresh and revocation', async () => {
    const base = await startApi({ MCP_RESOURCE_URL: 'http://127.0.0.1:0/mcp' });
    // Start the MCP HTTP server, then point the API at its real resource URL.
    const mcpCfg = { apiUrl: base, publicUrl: base, port: 0, host: '127.0.0.1', resourceUrl: '', issuer: base, serviceSecret: t.ctx.cfg.SERVICE_SECRET_MCP };
    const { server } = createMcpHttpServer(mcpCfg);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    closers.push(() => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    });
    const mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    mcpCfg.resourceUrl = mcpUrl;
    (t.ctx.cfg as { MCP_RESOURCE_URL: string }).MCP_RESOURCE_URL = mcpUrl;
    (t.ctx.cfg as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN = base;

    // 1. Unauthenticated → 401 with resource metadata pointer.
    const r401 = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r401.status).toBe(401);
    expect(r401.headers.get('www-authenticate')).toContain('resource_metadata=');
    const meta = (await (await fetch(`${new URL(mcpUrl).origin}/.well-known/oauth-protected-resource`)).json()) as J;
    expect(meta.authorization_servers).toEqual([base]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as J;
    expect(as.code_challenge_methods_supported).toEqual(['S256']);

    // 2. Dynamic client registration.
    const reg = (await (await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['http://127.0.0.1:33418/callback'] }) })).json()) as J;
    expect(reg.client_id).toMatch(/^mcpc_/);

    // 3. Authorize with PKCE → consent screen (user signed in with Spotify) → code.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authUrl = `${as.authorization_endpoint}?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('http://127.0.0.1:33418/callback')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(mcpUrl)}`;
    const az = await fetch(authUrl, { redirect: 'manual' });
    expect(az.status).toBe(302);
    const requestId = new URL(az.headers.get('location')!, base).searchParams.get('request')!;
    const alice = await login(t, 'alice', { displayName: 'Alice' });
    const info = (await alice.req('GET', `/v1/oauth/requests/${requestId}`)).json();
    expect(info).toMatchObject({ clientName: 'Claude Code', redirectHost: '127.0.0.1:33418' });
    const approved = (await alice.req('POST', `/v1/oauth/requests/${requestId}/approve`, { approve: true })).json();
    const cb = new URL(approved.redirectTo);
    expect(cb.searchParams.get('state')).toBe('xyz');
    const code = cb.searchParams.get('code')!;

    // 4. Token exchange (wrong verifier fails, right one works).
    const tokenReq = (v: string) =>
      fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: v, client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:33418/callback' }),
      });
    expect((await tokenReq('wrong')).status).toBe(400);
    // The code was consumed by the failed attempt; get a fresh one.
    const az2 = await fetch(authUrl, { redirect: 'manual' });
    const rid2 = new URL(az2.headers.get('location')!, base).searchParams.get('request')!;
    const code2 = new URL((await alice.req('POST', `/v1/oauth/requests/${rid2}/approve`, { approve: true })).json().redirectTo).searchParams.get('code')!;
    const tok = (await (
      await fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:33418/callback' }),
      })
    ).json()) as J;
    expect(tok.token_type).toBe('Bearer');

    // The MCP token is audience-bound: the API itself rejects it.
    expect((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${tok.access_token}` } })).status).toBe(401);

    // 5. Use it with a real MCP client over Streamable HTTP.
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } });
    const mcp = new Client({ name: 'oauth-test', version: '1' });
    await mcp.connect(transport);
    closers.push(() => mcp.close());
    const created = (await mcp.callTool({ name: 'create_room', arguments: { name: 'Over HTTP' } })) as Res;
    expect(created.structuredContent).toMatchObject({ room: { slug: 'over-http' } });
    expect((await alice.req('GET', '/v1/me')).json().connections.mcp).toBe(true);

    // 6. Refresh rotates; revoking the connection kills it.
    const refreshed = (await (
      await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) })
    ).json()) as J;
    expect(refreshed.refresh_token).not.toBe(tok.refresh_token);
    const conn = (await alice.req('GET', '/v1/tokens')).json().find((x: { label: string }) => x.label === 'Claude Code');
    const del = await alice.req('DELETE', `/v1/tokens/${conn.id}`);
    expect(del.statusCode, del.body).toBe(200);
    const after = await fetch(mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${refreshed.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }) });
    expect(after.status).toBe(401);
  });
});

import { createDb } from '@spinroom/db';
import type { RoomEvent } from '@spinroom/contracts';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, login, type TestApp, type TestUser } from '../../api/test/helpers.js';
import { createSlackApp } from '../src/app.js';
import { CardScheduler } from '../src/cardSync.js';
import { slackConfig } from '../src/config.js';
import { createInstallationStore } from '../src/store.js';
import { createAesSealer } from '@spinroom/db';

const SIGNING = 'test-signing-secret';
let t: TestApp;
let closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
  await t?.close();
});

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** A fake Slack Web API + response_url sink that records every call. */
async function fakeSlack() {
  const calls: Call[] = [];
  let ts = 1700000000;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const ct = req.headers['content-type'] ?? '';
      const body: Record<string, unknown> = ct.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
      for (const k of ['blocks', 'view']) if (typeof body[k] === 'string') body[k] = JSON.parse(body[k] as string);
      const method = req.url!.replace(/^\/api\//, '').replace(/^\//, '');
      calls.push({ method, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: `${++ts}.000100`, channel: { id: 'D-DM' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, base, apiUrl: `${base}/api/` };
}

function sign(body: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex')}`;
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig };
}

async function setup() {
  t = await createTestApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const apiBase = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  (t.ctx.cfg as { PUBLIC_ORIGIN: string }).PUBLIC_ORIGIN = apiBase;
  const slack = await fakeSlack();
  const cfg = {
    ...slackConfig({}),
    signingSecret: SIGNING,
    apiUrl: apiBase,
    publicUrl: apiBase,
    serviceSecret: t.ctx.cfg.SERVICE_SECRET_SLACK,
    databaseUrl: t.ctx.cfg.DATABASE_URL,
    redisUrl: t.ctx.cfg.REDIS_URL,
    encryptionKey: t.ctx.cfg.ENCRYPTION_KEY,
    slackApiUrl: slack.apiUrl,
    cardIntervalMs: 300,
  };
  const { db, close } = createDb(cfg.databaseUrl, 3);
  const redis = new Redis(cfg.redisUrl);
  const sub = new Redis(cfg.redisUrl);
  const app = createSlackApp(cfg, { db, redis, sub });
  const server = (await app.start(0)) as unknown as Server;
  closers.push(async () => {
    await app.stop();
    redis.disconnect();
    sub.disconnect();
    await close();
  });
  const slackUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await createInstallationStore(db, createAesSealer(cfg.encryptionKey)).storeInstallation({
    team: { id: 'T1', name: 'Test Team' },
    enterprise: undefined,
    user: { id: 'UADMIN', token: undefined, scopes: undefined },
    bot: { token: 'xoxb-test', scopes: [], id: 'B1', userId: 'UBOT' },
    isEnterpriseInstall: false,
  } as never);

  const post = async (path: string, form: Record<string, string>) => {
    const body = new URLSearchParams(form).toString();
    return fetch(`${slackUrl}/v1/integrations/slack/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...sign(body) },
      body,
    });
  };
  let n = 0;
  const command = async (user: string, text: string, channel = 'C1') => {
    const id = `r${++n}`;
    const res = await post('commands', {
      team_id: 'T1',
      channel_id: channel,
      user_id: user,
      command: '/spinroom',
      text,
      trigger_id: `trig${n}`,
      response_url: `${slack.base}/response/${id}`,
    });
    expect(res.status).toBe(200);
    // respond() goes to the response_url; wait for it.
    for (let i = 0; i < 100; i++) {
      const c = slack.calls.find((x) => x.method === `response/${id}`);
      if (c) return c.body;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no response for ${text}`);
  };
  const action = async (user: string, actionId: string, value: string) => {
    const id = `a${++n}`;
    const payload = {
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: user },
      trigger_id: `trig${n}`,
      response_url: `${slack.base}/response/${id}`,
      channel: { id: 'C1' },
      actions: [{ action_id: actionId, value, type: 'button', block_id: 'b' }],
    };
    await post('interactivity', { payload: JSON.stringify(payload) });
    for (let i = 0; i < 100; i++) {
      const c = slack.calls.find((x) => x.method === `response/${id}`);
      if (c) return c.body;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no action response');
  };
  return { slack, slackUrl, apiBase, post, command, action };
}

async function connect(s: Awaited<ReturnType<typeof setup>>, slackUser: string, u: TestUser) {
  const r = await s.command(slackUser, 'hype');
  const blocks = JSON.stringify(r.blocks);
  const url = new URL(blocks.match(/"url":"([^"]+\/slack\/link[^"]+)"/)![1]!.replace(/\\u0026/g, '&'));
  const res = await u.req('POST', '/v1/me/identity-links', {
    provider: 'slack',
    teamId: url.searchParams.get('team'),
    externalId: url.searchParams.get('user'),
    exp: Number(url.searchParams.get('exp')),
    sig: url.searchParams.get('sig'),
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function playingRoom(owner: TestUser) {
  const { room } = (await owner.req('POST', '/v1/rooms', { name: 'Team Radio' })).json();
  await owner.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Neon Tide' });
  const sp = (await owner.req('POST', '/v1/speakers', { roomSlug: room.slug, kind: 'fake' })).json();
  await owner.req('POST', `/v1/speakers/${sp.id}/heartbeat`, { status: 'live', audible: true });
  await owner.req('POST', `/v1/rooms/${room.slug}/dj-queue`);
  return room as { slug: string; id: string };
}

describe('Slack app (Journey 4)', () => {
  it('rejects unsigned requests', async () => {
    const s = await setup();
    const res = await fetch(`${s.slackUrl}/v1/integrations/slack/commands`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': `${Math.floor(Date.now() / 1000)}`,
        'x-slack-signature': 'v0=bad',
      },
      body: 'command=/spinroom',
    });
    expect(res.status).toBe(401);
  });

  it('connects accounts, links a channel, posts a live card, and votes reach the web within 1 s', async () => {
    const s = await setup();
    const alice = await login(t, 'alice', { displayName: 'Alice' });
    const bob = await login(t, 'bob', { displayName: 'Bob' });

    // Unlinked users get a Connect button.
    const first = await s.command('U-ALICE', 'hype');
    expect(JSON.stringify(first.blocks)).toContain('Connect Spinroom');
    await connect(s, 'U-ALICE', alice);
    await connect(s, 'U-BOB', bob);

    const room = await playingRoom(alice);
    // Only owners/mods can link.
    expect((await s.command('U-BOB', `link ${room.slug}`)).text).toContain('Only the room’s owner');
    expect((await s.command('U-ALICE', `link ${room.slug}`)).text).toContain('Linked this channel to *Team Radio*');
    const posted = s.slack.calls.find((c) => c.method === 'chat.postMessage' && c.body.channel === 'C1')!;
    expect(String(posted.body.text)).toContain('Neon Tide');
    expect(JSON.stringify(posted.body.blocks)).toContain('sr_hype');

    // A web client listening on the room socket sees a Slack vote within a second.
    const ws = await t.app.injectWS(`/v1/rooms/${room.slug}/live`, { headers: { authorization: `Bearer ${alice.token}` } });
    closers.push(() => ws.terminate());
    const seen = new Promise<number>((resolve) =>
      ws.on('message', (d) => {
        const e = JSON.parse(String(d)) as RoomEvent;
        if (e.type === 'votes.changed' && e.tally.hype === 1) resolve(Date.now());
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    const sent = Date.now();
    const v = await s.command('U-BOB', 'hype');
    expect(v.text).toContain('Voted ▲ Hype');
    expect((await seen) - sent).toBeLessThan(1000);

    // The card is edited in place.
    await vi.waitFor(() => expect(s.slack.calls.some((c) => c.method === 'chat.update' && JSON.stringify(c.body.blocks).includes('Hype 1'))).toBe(true), {
      timeout: 3000,
    });

    // Card buttons work too.
    const skip = await s.action('U-BOB', 'sr_skip', room.slug);
    expect(String(skip.text)).toContain('Skip counted');

    // /spinroom now, dj, speaker, invite, add.
    expect(JSON.stringify((await s.command('U-BOB', 'now')).blocks)).toContain('Neon Tide');
    expect((await s.command('U-BOB', 'dj')).text).toMatch(/set first|playable track/i);
    expect((await s.command('U-BOB', 'add pixel rain')).text).toContain('Pixel Rain');
    expect((await s.command('U-BOB', 'dj')).text).toContain('booth');
    expect((await s.command('U-BOB', 'speaker')).text).toContain('DM');
    expect(s.slack.calls.some((c) => c.method === 'chat.postMessage' && String(c.body.text).includes('?speaker=1'))).toBe(true);
    expect((await s.command('U-ALICE', 'invite <@UCAROL|carol>')).text).toContain('Invite sent');
    expect(s.slack.calls.some((c) => c.method === 'chat.postMessage' && String(c.body.text).includes('/invite/inv_'))).toBe(true);
    // With no search text, `add` opens the search modal (no chat reply).
    await s.post('commands', {
      team_id: 'T1',
      channel_id: 'C1',
      user_id: 'U-BOB',
      command: '/spinroom',
      text: 'add',
      trigger_id: 'trig-modal',
      response_url: `${s.slack.base}/response/modal`,
    });
    await vi.waitFor(() => expect(s.slack.calls.some((c) => c.method === 'views.open')).toBe(true));
    expect((await s.command('U-ALICE', 'unlink')).text).toBe('Unlinked.');
  });

  it('"Join room" lets channel members into an invite-only room in one click; /spinroom button posts it', async () => {
    const s = await setup();
    const alice = await login(t, 'alice', { displayName: 'Alice' });
    const carol = await login(t, 'carol', { displayName: 'Carol' });
    await connect(s, 'U-ALICE', alice);
    const { room } = (await alice.req('POST', '/v1/rooms', { name: 'Secret Sessions', visibility: 'invite_only' })).json();

    // Unlinked channel + invite-only room without link sharing: no button that wouldn't work.
    expect((await s.command('U-ALICE', `button ${room.slug}`, 'C9')).text).toContain('is invite-only');

    await s.command('U-ALICE', `link ${room.slug}`);
    const card = s.slack.calls.find((c) => c.method === 'chat.postMessage' && c.body.channel === 'C1')!;
    const joinUrl = (raw: unknown) => new URL(JSON.stringify(raw).match(/"text":"🎧 Join room"[^}]*\},"style":"primary","url":"([^"]+)"/)![1]!.replace(/\\u0026/g, '&'));
    const url = joinUrl(card.body.blocks);
    expect(url.pathname).toBe(`/r/${room.slug}`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ speaker: '1', via: 'slack', team: 'T1', channel: 'C1' });

    // Carol isn't a member and never connected Slack: the link alone gets her in.
    const slack = { teamId: 'T1', channelId: 'C1', sig: url.searchParams.get('sig')! };
    expect((await carol.req('POST', `/v1/rooms/${room.slug}/join`, {})).json().code).toBe('not_member');
    expect((await carol.req('POST', `/v1/rooms/${room.slug}/join`, { slack })).json().me.role).toBe('member');

    // /spinroom button posts the same link for everyone in the channel.
    const posted = await s.command('U-ALICE', 'button');
    expect(posted.response_type).toBe('in_channel');
    expect(joinUrl(posted.blocks).searchParams.get('sig')).toBe(slack.sig);

    // Elsewhere, with "Anyone with the link" on, it uses the room's share link.
    await alice.req('PUT', `/v1/rooms/${room.slug}/share-link`, { enabled: true });
    const elsewhere = joinUrl((await s.command('U-ALICE', `button ${room.slug}`, 'C9')).blocks);
    expect(elsewhere.searchParams.get('key')).toMatch(/^rk_/);

    // Unlinking the channel retires its links.
    await s.command('U-ALICE', 'unlink');
    const dave = await login(t, 'dave');
    expect((await dave.req('POST', `/v1/rooms/${room.slug}/join`, { slack })).json().code).toBe('invalid_invite');
  });

  it('serves track search options for the Add to my set modal', async () => {
    const s = await setup();
    const alice = await login(t, 'alice');
    await connect(s, 'U-ALICE', alice);
    const payload = {
      type: 'block_suggestion',
      team: { id: 'T1' },
      user: { id: 'U-ALICE' },
      action_id: 'sr_track_search',
      block_id: 'track',
      value: 'neon',
      view: { callback_id: 'sr_add_modal' },
    };
    const res = await s.post('options', { payload: JSON.stringify(payload) });
    const json = (await res.json()) as { options: { text: { text: string }; value: string }[] };
    expect(json.options[0]!.text.text).toContain('Neon Tide');
    expect(json.options[0]!.value).toMatch(/^spotify:track:/);
  });
});

describe('card debounce', () => {
  it('never edits a channel more than once per 3 s under 20 votes in 10 s', async () => {
    vi.useFakeTimers();
    const runs: number[] = [];
    const sched = new CardScheduler(3000, async () => void runs.push(Date.now()));
    for (let i = 0; i < 20; i++) {
      sched.request('T1:C1');
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    const start = runs[0]!;
    expect(runs.filter((r) => r - start < 10_000).length).toBeLessThanOrEqual(4);
    for (let i = 1; i < runs.length; i++) expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(3000);
    expect(runs.length).toBeGreaterThanOrEqual(4); // the last vote still lands
  });
});

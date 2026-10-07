import type { RoomEvent } from '@spinroom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/lib/clock.js';
import { FakeSpotifyGateway, FAKE_CATALOG } from '../src/spotify/fake.js';
import { createTestApp, login, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
afterEach(async () => t?.close());

async function createRoom(u: TestUser, body: Record<string, unknown> = {}) {
  const res = await u.req('POST', '/v1/rooms', { name: 'Late Night Lounge', ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { room: { slug: string; id: string }; invite: { url: string; token: string } };
}

const track = (title: string) => FAKE_CATALOG.find((x) => x.title === title)!;

async function heartbeat(u: TestUser, slug: string) {
  const sp = await u.req('POST', '/v1/speakers', { roomSlug: slug, kind: 'fake', takeover: true });
  expect(sp.statusCode, sp.body).toBe(200);
  const hb = await u.req('POST', `/v1/speakers/${sp.json().id}/heartbeat`, { status: 'live', audible: true, positionMs: 0, driftMs: 12 });
  expect(hb.statusCode, hb.body).toBe(200);
  return sp.json().id as string;
}

describe('rooms and invites', () => {
  it('creates, lists and shows a public room', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const { room, invite } = await createRoom(alice, { description: 'chill' });
    expect(room.slug).toBe('late-night-lounge');
    expect(invite.url).toContain('/invite/inv_');
    const again = await createRoom(alice);
    expect(again.room.slug).toBe('late-night-lounge-2');
    const list = await t.app.inject({ method: 'GET', url: '/v1/rooms?filter=public' });
    expect(list.json().total).toBe(2);
    const anon = await t.app.inject({ method: 'GET', url: `/v1/rooms/${room.slug}` });
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).toMatchObject({ status: 'idle', me: null, room: { name: 'Late Night Lounge' } });
    const mine = await alice.req('GET', '/v1/rooms?filter=mine');
    expect(mine.json().rooms.map((r: { myRole: string }) => r.myRole)).toEqual(['owner', 'owner']);
    const taken = await alice.req('POST', '/v1/rooms', { name: 'XY', slug: 'late-night-lounge' });
    expect(taken.json().code).toBe('slug_taken');
  });

  it('gates invite-only rooms behind expiring, revocable invites', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob');
    const { room, invite } = await createRoom(alice, { visibility: 'invite_only' });
    expect((await bob.req('GET', `/v1/rooms/${room.slug}`)).json().code).toBe('not_member');
    expect((await t.app.inject({ method: 'GET', url: '/v1/rooms?filter=public' })).json().total).toBe(0);
    const preview = await t.app.inject({ method: 'GET', url: `/v1/invites/${invite.token}` });
    expect(preview.json().room.name).toBe('Late Night Lounge');
    const acc = await bob.req('POST', `/v1/invites/${invite.token}/accept`);
    expect(acc.statusCode).toBe(200);
    expect((await bob.req('GET', `/v1/rooms/${room.slug}`)).statusCode).toBe(200);

    const carol = await login(t, 'carol');
    const inv2 = (await bob.req('POST', `/v1/rooms/${room.slug}/invites`, { expiresInMs: 60_000 })).json();
    await alice.req('DELETE', `/v1/invites/${inv2.id}`);
    expect((await carol.req('POST', `/v1/invites/${inv2.token}/accept`)).json().code).toBe('invalid_invite');
  });

  it('expires invites after their TTL', async () => {
    const clock = new ManualClock(Date.now());
    t = await createTestApp({ clock });
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob');
    const { room } = await createRoom(alice, { visibility: 'invite_only' });
    const inv = (await alice.req('POST', `/v1/rooms/${room.slug}/invites`, { expiresInMs: 60_000 })).json();
    clock.advance(61_000);
    expect((await bob.req('POST', `/v1/rooms/${room.slug}/join`, { invite: inv.url })).json().code).toBe('invalid_invite');
  });
});

describe('sets (My set)', () => {
  it('creates a "Spinroom – <room>" playlist and appends tracks; Spotify edits flow back', async () => {
    const spotify = new FakeSpotifyGateway();
    t = await createTestApp({ spotify });
    const alice = await login(t, 'alice');
    const { room } = await createRoom(alice);
    const c1 = (await alice.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Neon Tide' })).json();
    expect(c1.mode).toBe('playlist');
    expect(c1.items.map((i: { track: { title: string } }) => i.track.title)).toEqual(['Neon Tide']);
    const playlists = await spotify.listMyPlaylists('fake.alice.premium');
    const pl = playlists.find((p) => p.name === 'Spinroom – Late Night Lounge')!;
    expect(pl.trackCount).toBe(1);
    await alice.req('POST', `/v1/rooms/${room.slug}/crate`, { trackUri: track('Booth Lights').uri });
    // Edit in "the Spotify app": add a track at the top.
    spotify.externalEdit(pl.id, (uris) => uris.unshift(track('Pixel Rain').uri));
    await t.ctx.services.rooms.sets.refresh(room.id, alice.id);
    const c2 = (await alice.req('GET', `/v1/rooms/${room.slug}/crate`)).json();
    expect(c2.items.map((i: { track: { title: string } }) => i.track.title)).toEqual(['Pixel Rain', 'Neon Tide', 'Booth Lights']);
    // Reorder and remove.
    const moved = (await alice.req('PATCH', `/v1/rooms/${room.slug}/crate/${c2.items[2].id}`, { position: 0 })).json();
    expect(moved.items[0].track.title).toBe('Booth Lights');
    const removed = (await alice.req('DELETE', `/v1/rooms/${room.slug}/crate/${moved.items[1].id}`)).json();
    expect(removed.items.map((i: { track: { title: string } }) => i.track.title)).toEqual(['Booth Lights', 'Neon Tide']);
  });

  it('falls back to a Spinroom-side set when playlist writes are blocked', async () => {
    const spotify = new FakeSpotifyGateway();
    spotify.playlistWritesBlocked = true;
    t = await createTestApp({ spotify });
    const alice = await login(t, 'alice');
    const { room } = await createRoom(alice);
    const c = (await alice.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Neon Tide' })).json();
    expect(c.mode).toBe('local');
    expect(c.notice).toContain('stored in Spinroom');
    expect(c.items).toHaveLength(1);
    // Read-only import still works.
    const pls = await spotify.listMyPlaylists('fake.alice.premium');
    const imp = (await alice.req('POST', `/v1/rooms/${room.slug}/crate/import`, { mode: 'copy', playlist: `https://open.spotify.com/playlist/${pls[0]!.id}` })).json();
    expect(imp.mode).toBe('local');
    expect(imp.items.length).toBe(8);
  });

  it('refuses too-long and explicit tracks per room settings, flags unplayable ones', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const { room } = await createRoom(alice, { settings: { blockExplicit: true } });
    expect((await alice.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Endless Jam' })).json().code).toBe('track_too_long');
    expect((await alice.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Swear Jar' })).json().code).toBe('track_explicit');
    const c = (await alice.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Region Locked' })).json();
    expect(c.items[0].flags).toEqual(['unplayable']);
  });
});

describe('DJ queue, spins and votes', () => {
  it('runs a room: DJ queue → spin → votes by surface → auto-skip → history', async () => {
    const clock = new ManualClock(Date.now());
    t = await createTestApp({ clock });
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob', { surface: 'mcp' });
    const carol = await login(t, 'carol', { surface: 'slack' });
    const dee = await login(t, 'dee', { surface: 'mcp' });
    const { room } = await createRoom(alice);

    await heartbeat(alice, room.slug);
    expect((await alice.req('POST', `/v1/rooms/${room.slug}/dj-queue`)).json().code).toBe('crate_empty');
    await alice.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Neon Tide' });
    await alice.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Booth Lights' });
    const q = (await alice.req('POST', `/v1/rooms/${room.slug}/dj-queue`)).json();
    expect(q).toEqual({ boothSlot: 0, queuePosition: null });

    let snap = (await alice.req('GET', `/v1/rooms/${room.slug}`)).json();
    expect(snap.status).toBe('playing');
    expect(snap.currentSpin.track.title).toBe('Neon Tide');
    expect(snap.me).toMatchObject({ role: 'owner', boothSlot: 0, speakerStatus: 'live' });

    // Remote votes (no speaker) are recorded but don't count toward auto-skip (FR-L3).
    for (const u of [bob, carol]) await u.req('POST', `/v1/rooms/${room.slug}/join`);
    const v1 = (await bob.req('PUT', `/v1/rooms/${room.slug}/spins/current/vote`, { value: 'skip' })).json();
    expect(v1).toMatchObject({ myVote: 'skip', counted: false, tally: { skip: 1, eligibleVoters: 0 } });
    const v2 = (await carol.req('PUT', `/v1/rooms/${room.slug}/spins/current/vote`, { value: 'skip' })).json();
    expect(v2.tally.skip).toBe(2);
    snap = (await alice.req('GET', `/v1/rooms/${room.slug}`)).json();
    expect(snap.currentSpin.track.title).toBe('Neon Tide');

    // Once their speakers go live, their existing Skip votes count: 2 of 2 eligible → auto-skip.
    await heartbeat(bob, room.slug);
    snap = (await alice.req('GET', `/v1/rooms/${room.slug}`)).json();
    expect(snap.currentSpin.track.title).toBe('Neon Tide'); // 1 eligible Skip < minSkips
    await heartbeat(carol, room.slug);
    snap = (await alice.req('GET', `/v1/rooms/${room.slug}`)).json();
    expect(snap.currentSpin?.track.title).toBe('Booth Lights');
    expect(snap.currentSpin.startedAtServerMs).toBe(clock.now() + 3000);
    await heartbeat(dee, room.slug);
    const v3 = (await bob.req('PUT', `/v1/rooms/${room.slug}/spins/current/vote`, { value: 'hype' })).json();
    expect(v3).toMatchObject({ counted: true, myVote: 'hype', tally: { hype: 1, eligibleVoters: 3 } });
    expect((await alice.req('PUT', `/v1/rooms/${room.slug}/spins/current/vote`, { value: 'hype' })).json().code).toBe('cannot_vote_own_spin');

    // Moderators see who voted what; members don't.
    await dee.req('PUT', `/v1/rooms/${room.slug}/spins/current/vote`, { value: 'hype' });
    expect((await bob.req('GET', `/v1/rooms/${room.slug}/spins/current/votes`)).json().code).toBe('forbidden');
    const who = (await alice.req('GET', `/v1/rooms/${room.slug}/spins/current/votes`)).json();
    expect(who).toEqual(expect.arrayContaining([{ userId: dee.id, value: 'hype', surface: 'mcp' }, { userId: bob.id, value: 'hype', surface: 'mcp' }]));

    // Let the spin finish via the tick safety net.
    clock.advance(snap.currentSpin.durationMs + 3000 + 3000);
    await heartbeat(alice, room.slug);
    const hist = (await alice.req('GET', `/v1/rooms/${room.slug}/history?limit=5`)).json();
    expect(hist.map((h: { endReason: string | null }) => h.endReason)).toEqual([null, 'completed', 'auto_skip']);
    expect(hist[2]).toMatchObject({ djName: 'Alice', skip: 2, eligibleVoters: 2, track: { title: 'Neon Tide' } });
    expect(hist[1]).toMatchObject({ hype: 2, eligibleVoters: 3, track: { title: 'Booth Lights' } });
    // Two Hype of three eligible is Hype-heavy: Alice earned a point (FR-V5).
    expect((await alice.req('GET', '/v1/me')).json().points).toBe(1);

    // DJ skips own spin, others can't.
    expect((await bob.req('POST', `/v1/rooms/${room.slug}/spins/current/skip`)).json().code).toBe('forbidden');
    expect((await alice.req('POST', `/v1/rooms/${room.slug}/spins/current/skip`)).statusCode).toBe(200);
  });

  it('keeps Free accounts out of the booth and speaker', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const fred = await login(t, 'fred', { premium: false });
    const { room } = await createRoom(alice);
    await fred.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Neon Tide' });
    expect((await fred.req('POST', `/v1/rooms/${room.slug}/dj-queue`)).json().code).toBe('not_premium');
    expect((await fred.req('POST', '/v1/speakers', { roomSlug: room.slug, kind: 'fake' })).json().code).toBe('not_premium');
  });

  it('allows one live speaker per member; a second one asks to move', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const { room } = await createRoom(alice);
    const first = await heartbeat(alice, room.slug);
    const second = await alice.req('POST', '/v1/speakers', { roomSlug: room.slug, kind: 'fake' });
    expect(second.json()).toMatchObject({ code: 'speaker_exists', meta: { speakerId: first } });
    const moved = await alice.req('POST', '/v1/speakers', { roomSlug: room.slug, kind: 'fake', takeover: true });
    expect(moved.statusCode).toBe(200);
    const old = await alice.req('POST', `/v1/speakers/${first}/heartbeat`, { status: 'live', audible: true });
    expect(old.json().superseded).toBe(true);
  });

  it('rebuilds a playing room from Postgres when Redis state is lost', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob');
    const { room } = await createRoom(alice);
    for (const u of [alice, bob]) {
      await u.req('POST', `/v1/rooms/${room.slug}/crate`, { query: 'Neon' });
      await heartbeat(u, room.slug);
      await u.req('POST', `/v1/rooms/${room.slug}/dj-queue`);
    }
    const before = (await alice.req('GET', `/v1/rooms/${room.slug}`)).json();
    await t.ctx.redis.del(`room:${room.id}:state`);
    const after = (await alice.req('GET', `/v1/rooms/${room.slug}`)).json();
    expect(after.currentSpin.id).toBe(before.currentSpin.id);
    expect(after.currentSpin.startedAtServerMs).toBe(before.currentSpin.startedAtServerMs);
    expect(after.booth.map((b: { userId: string }) => b.userId)).toEqual(before.booth.map((b: { userId: string }) => b.userId));
  });
});

describe('chat and moderation', () => {
  it('rate limits chat to 5 messages per 10 s and strips control characters', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const { room } = await createRoom(alice);
    const first = (await alice.req('POST', `/v1/rooms/${room.slug}/chat`, { text: 'hi\u0007 <b>there</b>' })).json();
    expect(first.text).toBe('hi <b>there</b>');
    for (let i = 0; i < 4; i++) expect((await alice.req('POST', `/v1/rooms/${room.slug}/chat`, { text: `m${i}` })).statusCode).toBe(200);
    expect((await alice.req('POST', `/v1/rooms/${room.slug}/chat`, { text: 'too many' })).json().code).toBe('rate_limited');
    const react = await alice.req('POST', `/v1/rooms/${room.slug}/chat/${first.id}/reactions`, { emoji: '🔥' });
    expect(react.json().reactions['🔥']).toEqual([alice.id]);
    expect((await alice.req('POST', `/v1/rooms/${room.slug}/chat/${first.id}/reactions`, { emoji: 'lol' })).statusCode).toBe(400);
  });

  it('lets moderators mute, kick and ban; only owners change roles', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob');
    const carol = await login(t, 'carol');
    const { room } = await createRoom(alice);
    for (const u of [bob, carol]) await u.req('POST', `/v1/rooms/${room.slug}/join`);
    expect((await bob.req('POST', `/v1/rooms/${room.slug}/moderation`, { action: 'mute', userId: carol.id })).json().code).toBe('forbidden');
    await alice.req('POST', `/v1/rooms/${room.slug}/moderation`, { action: 'set_role', userId: bob.id, role: 'moderator' });
    await bob.req('POST', `/v1/rooms/${room.slug}/moderation`, { action: 'mute', userId: carol.id });
    expect((await carol.req('POST', `/v1/rooms/${room.slug}/chat`, { text: 'hey' })).json().code).toBe('muted');
    expect((await bob.req('POST', `/v1/rooms/${room.slug}/moderation`, { action: 'kick', userId: alice.id })).json().code).toBe('forbidden');
    await bob.req('POST', `/v1/rooms/${room.slug}/moderation`, { action: 'ban', userId: carol.id });
    expect((await carol.req('POST', `/v1/rooms/${room.slug}/join`)).json().code).toBe('banned');
    const members = (await alice.req('GET', `/v1/rooms/${room.slug}/members`)).json();
    expect(members.find((m: { userId: string }) => m.userId === carol.id)).toMatchObject({ banned: true, muted: true });
  });
});

describe('live socket', () => {
  it('sends a snapshot then sequential events; resync returns a fresh snapshot', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob', { surface: 'mcp' });
    const { room } = await createRoom(alice);
    const ws = await t.app.injectWS(`/v1/rooms/${room.slug}/live`, { headers: { authorization: `Bearer ${alice.token}` } });
    const got: RoomEvent[] = [];
    const waitFor = (pred: (e: RoomEvent) => boolean, ms = 3000) =>
      new Promise<RoomEvent>((resolve, reject) => {
        const found = got.find(pred);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`timeout; got ${got.map((g) => g.type).join(',')}`)), ms);
        ws.on('message', (d) => {
          const e = JSON.parse(String(d));
          if (pred(e)) {
            clearTimeout(timer);
            resolve(e);
          }
        });
      });
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    const snap = await waitFor((e) => e.type === 'room.snapshot');
    expect(snap.type === 'room.snapshot' && snap.snapshot.me?.role).toBe('owner');

    const sent = await bob.req('POST', `/v1/rooms/${room.slug}/chat`, { text: 'yo' });
    expect(sent.statusCode, sent.body).toBe(200);
    const chat = await waitFor((e) => e.type === 'chat.message');
    const seqs = got.filter((e) => e.type !== 'room.snapshot').map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    expect(chat.type === 'chat.message' && chat.message.text).toBe('yo');

    // Bob's MCP join shows up as a remote presence with his profile.
    const pres = await waitFor((e) => e.type === 'presence.changed' && e.userId === bob.id);
    expect(pres.type === 'presence.changed' && pres.member?.user.displayName).toBe('Bob');

    const n = got.filter((e) => e.type === 'room.snapshot').length;
    ws.send(JSON.stringify({ type: 'resync' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(got.filter((e) => e.type === 'room.snapshot').length).toBe(n + 1);
    ws.send(JSON.stringify({ type: 'ping', t: 5 }));
    await new Promise((r) => setTimeout(r, 100));
    ws.terminate();
  });

  it('refuses invite-only rooms to outsiders', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob');
    const { room } = await createRoom(alice, { visibility: 'invite_only' });
    const ws = await t.app.injectWS(`/v1/rooms/${room.slug}/live`, { headers: { authorization: `Bearer ${bob.token}` } });
    const msg = await new Promise<{ code: string }>((r) => ws.on('message', (d) => r(JSON.parse(String(d)))));
    expect(msg.code).toBe('not_member');
    ws.terminate();
  });
});

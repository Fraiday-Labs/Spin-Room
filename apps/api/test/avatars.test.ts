import { afterEach, describe, expect, it } from 'vitest';
import { makeKit, makeSheet, multipart, V1_ROWS } from './fixtures/pets.js';
import { createTestApp, login, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
afterEach(async () => t?.close());

async function upload(u: TestUser, files: Parameters<typeof multipart>[0], query = '') {
  const mp = multipart(files);
  const res = await t.app.inject({ method: 'POST', url: `/v1/avatars${query}`, payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${u.token}` } });
  return res;
}

describe('avatar import (ChatGPT pets)', () => {
  it('imports a sprite kit zip, previews it, and needs rights confirmation to save', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const sheet = await makeSheet({ rows: V1_ROWS, format: 'webp' });
    const kit = makeKit({ 'pet.json': JSON.stringify({ name: 'Mochi <script>', spritesheet: 'spritesheet.webp', spriteVersionNumber: 1, evil: { a: 1 } }), 'spritesheet.webp': sheet });

    const dry = (await upload(u, [{ filename: 'mochi.codex-pet.zip', data: kit }], '?dryRun=true')).json();
    expect(dry).toMatchObject({ ok: true, avatar: null, sourceFormat: 'pet_v1', suggestedName: 'Mochi script', detectedSize: { w: 1536, h: 1872 } });
    expect(dry.frameCounts).toMatchObject({ idle: 8, jumping: 5, failed: 3, running: 6, 'running-right': 6, waving: 4, waiting: 2 });
    expect(dry.preview.rows.map((r: { state: string; frames: number }) => [r.state, r.frames])).toEqual([
      ['idle', 8],
      ['hype', 5],
      ['skip', 3],
      ['dj', 6],
      ['walk', 6],
      ['wave', 4],
      ['away', 2],
    ]);
    const sheetRes = await t.app.inject({ method: 'GET', url: dry.preview.sheetUrl });
    expect(sheetRes.headers['content-type']).toBe('image/webp');
    expect(sheetRes.rawPayload.length).toBeLessThanOrEqual(150 * 1024);
    const thumb = await t.app.inject({ method: 'GET', url: dry.preview.thumbUrl });
    expect(thumb.headers['content-type']).toBe('image/png');

    expect((await upload(u, [{ filename: 'kit.zip', data: kit }])).json().code).toBe('rights_not_confirmed');
    const saved = (await upload(u, [{ filename: 'kit.zip', data: kit }], '?rightsConfirmed=true')).json();
    expect(saved.avatar).toMatchObject({ status: 'pending', kind: 'custom', name: 'Mochi script', sourceFormat: 'pet_v1' });
    expect((await u.req('GET', '/v1/avatars/mine')).json()).toHaveLength(1);
  });

  it('imports single v1 and v2 sheets and pet folder files', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const v1 = (await upload(u, [{ filename: 'sheet.png', data: await makeSheet({ rows: V1_ROWS }) }], '?dryRun=true')).json();
    expect(v1).toMatchObject({ ok: true, sourceFormat: 'single_sheet' });
    expect(v1.issues).toEqual([]);

    const v2Rows = [...V1_ROWS, 8, 8];
    const v2 = (await upload(u, [{ filename: 'sheet.webp', data: await makeSheet({ h: 2288, rows: v2Rows, format: 'webp' }) }], '?dryRun=true')).json();
    expect(v2).toMatchObject({ ok: true, detectedSize: { w: 1536, h: 2288 } });

    const folder = (
      await upload(
        u,
        [
          { filename: 'pet.json', data: Buffer.from(JSON.stringify({ name: 'Tako', spritesheet: 'spritesheet.png', spriteVersionNumber: 2 })) },
          { filename: 'spritesheet.png', data: await makeSheet({ h: 2288, rows: v2Rows }) },
        ],
        '?dryRun=true',
      )
    ).json();
    expect(folder).toMatchObject({ ok: true, sourceFormat: 'pet_v2', suggestedName: 'Tako' });
  });

  it('falls back to idle for empty rows with warnings, dimming away', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const r = (await upload(u, [{ filename: 's.png', data: await makeSheet({ rows: [4] }) }], '?dryRun=true')).json();
    expect(r.ok).toBe(true);
    expect(r.issues.map((i: { code: string }) => i.code)).toContain('row_empty_jumping');
    expect(r.preview.rows.find((x: { state: string }) => x.state === 'away')).toMatchObject({ frames: 4, dimmed: true });
  });

  const invalid: [string, () => Promise<{ filename: string; data: Buffer }[]>, string, RegExp?][] = [
    ['wrong size', async () => [{ filename: 'x.png', data: await makeSheet({ w: 1024, h: 1024, rows: [1] }) }], 'size_unsupported', /1024 × 1024\. ChatGPT pet sheets are 1536 × 1872 or 1536 × 2288 — use Download sprite kit in ChatGPT\./],
    ['no alpha', async () => [{ filename: 'x.png', data: await makeSheet({ rows: [8], alpha: false }) }], 'no_alpha'],
    ['jpeg', async () => [{ filename: 'x.png', data: await makeSheet({ rows: [8], format: 'jpeg', alpha: false }) }], 'format_unsupported'],
    ['empty idle row', async () => [{ filename: 'x.png', data: await makeSheet({ rows: [0, 4, 4] }) }], 'idle_empty'],
    ['zip path traversal', async () => [{ filename: 'k.zip', data: makeKit({ 'pet.json': '{"spritesheet":"s.png"}', '../s.png': await makeSheet({ rows: [8] }) }) }], 'zip_nested'],
    ['zip nested folder', async () => [{ filename: 'k.zip', data: makeKit({ 'pet/pet.json': '{}', 'pet/s.png': Buffer.from('x') }) }], 'zip_nested'],
    ['zip extra files', async () => [{ filename: 'k.zip', data: makeKit({ 'pet.json': '{"spritesheet":"s.png"}', 's.png': await makeSheet({ rows: [8] }), 'run.sh': 'echo hi' }) }], 'zip_extra_files'],
    ['zip without pet.json', async () => [{ filename: 'k.zip', data: makeKit({ 's.png': Buffer.from('x') }) }], 'pet_json_missing'],
    ['huge pet.json', async () => [{ filename: 'k.zip', data: makeKit({ 'pet.json': JSON.stringify({ name: 'x'.repeat(70_000) }), 's.png': Buffer.from('x') }) }], 'pet_json_too_large'],
    ['bad pet.json', async () => [{ filename: 'pet.json', data: Buffer.from('{nope') }, { filename: 's.png', data: await makeSheet({ rows: [8] }) }], 'pet_json_invalid'],
  ];
  for (const [label, files, code, msg] of invalid) {
    it(`rejects: ${label} → ${code}`, async () => {
      t = await createTestApp();
      const u = await login(t, 'alice');
      const r = (await upload(u, await files(), '?dryRun=true')).json();
      expect(r.ok).toBe(false);
      expect(r.issues[0].code).toBe(code);
      if (msg) expect(r.issues[0].message).toMatch(msg);
    });
  }

  it('asks for manual grid entry on non-standard divisible sheets', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const data = await makeSheet({ w: 1536, h: 1040, rows: [8, 4, 4, 4, 4] });
    const r1 = (await upload(u, [{ filename: 'x.png', data }], '?dryRun=true')).json();
    expect(r1).toMatchObject({ ok: false, needsGrid: { cols: 8, rows: 5 } });
    const r2 = (await upload(u, [{ filename: 'x.png', data }], '?dryRun=true&cols=8&rows=5')).json();
    expect(r2.ok).toBe(true);
  });

  it('rejects uploads over 10 MB', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const res = await upload(u, [{ filename: 'x.png', data: Buffer.alloc(11 * 1024 * 1024, 1) }]);
    expect(res.json().code).toBe('payload_too_large');
  });

  it('stores files by content hash and reuses them', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const data = await makeSheet({ rows: V1_ROWS });
    const a = (await upload(u, [{ filename: 'a.png', data }], '?dryRun=true')).json();
    const b = (await upload(u, [{ filename: 'b.png', data }], '?dryRun=true')).json();
    expect(a.preview.sheetUrl).toBe(b.preview.sheetUrl);
    expect(a.preview.sheetUrl).toMatch(/\/v1\/assets\/avatars\/sheet\/[0-9a-f]{64}\.webp$/);
  });
});

describe('avatar moderation (FR-A11–A16)', () => {
  it('shows a pending avatar only to its owner; approval reveals it; removal reverts everyone', async () => {
    t = await createTestApp({ cfg: { ADMIN_SPOTIFY_IDS: 'admin' } });
    const alice = await login(t, 'alice');
    const bob = await login(t, 'bob');
    const admin = await login(t, 'admin');
    const room = (await alice.req('POST', '/v1/rooms', { name: 'Pets' })).json().room;
    await bob.req('POST', `/v1/rooms/${room.slug}/join`);
    const saved = (await upload(alice, [{ filename: 's.png', data: await makeSheet({ rows: V1_ROWS }) }], '?rightsConfirmed=true')).json();
    const id = saved.avatar.id;
    await alice.req('PUT', '/v1/me/avatar', { avatarId: id });
    expect((await alice.req('GET', '/v1/me')).json().avatar.id).toBe(id);
    expect((await bob.req('GET', `/v1/avatars/${id}`)).statusCode).toBe(404);

    // Others see Alice's preset while pending.
    await t.ctx.services.rooms.exec(room.id, { type: 'remoteAction', userId: alice.id, role: 'owner' });
    let snap = (await bob.req('GET', `/v1/rooms/${room.slug}`)).json();
    expect(snap.members.find((m: { user: { id: string } }) => m.user.id === alice.id).user.avatar.kind).toBe('preset');

    expect((await bob.req('GET', '/v1/admin/avatars')).json().code).toBe('forbidden');
    const queue = (await admin.req('GET', '/v1/admin/avatars')).json();
    expect(queue.pending.map((a: { id: string }) => a.id)).toEqual([id]);
    await admin.req('POST', `/v1/admin/avatars/${id}/review`, { decision: 'approve' });
    snap = (await bob.req('GET', `/v1/rooms/${room.slug}`)).json();
    expect(snap.members.find((m: { user: { id: string } }) => m.user.id === alice.id).user.avatar.id).toBe(id);

    // Moderators can hide it in their room (FR-A15).
    await alice.req('POST', `/v1/rooms/${room.slug}/moderation`, { action: 'set_role', userId: bob.id, role: 'moderator' });
    const bobRoom = (await bob.req('POST', '/v1/rooms', { name: 'Bobs' })).json().room;
    await alice.req('POST', `/v1/rooms/${bobRoom.slug}/join`);
    await t.ctx.services.rooms.exec(bobRoom.id, { type: 'remoteAction', userId: alice.id, role: 'member' });
    await bob.req('POST', `/v1/rooms/${bobRoom.slug}/moderation`, { action: 'hide_avatar', userId: alice.id });
    const bobSnap = (await bob.req('GET', `/v1/rooms/${bobRoom.slug}`)).json();
    expect(bobSnap.members.find((m: { user: { id: string } }) => m.user.id === alice.id)).toMatchObject({ avatarHidden: true, user: { avatar: { kind: 'preset' } } });

    // Report → admin removes everywhere → Alice reverts to her preset; violation counted.
    await bob.req('POST', `/v1/avatars/${id}/report`, { reason: 'Looks like a famous mascot', roomSlug: room.slug });
    expect((await admin.req('GET', '/v1/admin/avatars')).json().reports).toHaveLength(1);
    await admin.req('POST', `/v1/admin/avatars/${id}/review`, { decision: 'remove' });
    expect((await alice.req('GET', '/v1/me')).json().avatar.kind).toBe('preset');
    expect((await admin.req('GET', '/v1/admin/avatars')).json().reports).toHaveLength(0);
  });

  it('caps custom avatars at 5 and revokes uploads after repeated violations', async () => {
    t = await createTestApp({ cfg: { ADMIN_SPOTIFY_IDS: 'admin' } });
    const alice = await login(t, 'alice');
    const admin = await login(t, 'admin');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = (await upload(alice, [{ filename: 's.png', data: await makeSheet({ rows: [8, i + 1] }) }], '?rightsConfirmed=true')).json();
      ids.push(r.avatar.id);
    }
    expect((await upload(alice, [{ filename: 's.png', data: await makeSheet({ rows: [7] }) }], '?rightsConfirmed=true')).json().code).toBe('avatar_limit');
    for (const id of ids.slice(0, 3)) await admin.req('POST', `/v1/admin/avatars/${id}/review`, { decision: 'reject' });
    expect((await alice.req('GET', '/v1/me')).json().uploadRevoked).toBe(true);
    expect((await upload(alice, [{ filename: 's.png', data: await makeSheet({ rows: [7] }) }], '?rightsConfirmed=true')).json().code).toBe('upload_revoked');
  });
});

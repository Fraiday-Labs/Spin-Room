import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { isolateCells } from '../src/avatars/pipeline.js';
import { AVATAR_BUILD, refreshAvatars } from '../src/avatars/rebuild.js';
import { avatars } from '../src/db/schema.js';
import { makeKit, makeSheet, multipart, V1_ROWS } from './fixtures/pets.js';
import { createTestApp, login, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
afterEach(async () => t?.close());

async function upload(u: TestUser, files: Parameters<typeof multipart>[0], query = '') {
  const mp = multipart(files);
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/avatars${query}`,
    payload: mp.payload,
    headers: { ...mp.headers, authorization: `Bearer ${u.token}` },
  });
  return res;
}

describe('avatar import (ChatGPT pets)', () => {
  it('imports a sprite kit zip, previews it, and needs rights confirmation to save', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const sheet = await makeSheet({ rows: V1_ROWS, format: 'webp' });
    const kit = makeKit({
      'pet.json': JSON.stringify({ name: 'Mochi <script>', spritesheet: 'spritesheet.webp', spriteVersionNumber: 1, evil: { a: 1 } }),
      'spritesheet.webp': sheet,
    });

    const dry = (await upload(u, [{ filename: 'mochi.codex-pet.zip', data: kit }], '?dryRun=true')).json();
    expect(dry).toMatchObject({ ok: true, avatar: null, sourceFormat: 'pet_v1', suggestedName: 'Mochi script', detectedSize: { w: 1536, h: 1872 } });
    expect(dry.frameCounts).toMatchObject({ idle: 8, jumping: 5, failed: 3, running: 6, 'running-right': 6, waving: 4, waiting: 2 });
    expect(dry.preview.rows.map((r: { state: string; frames: number }) => [r.state, r.frames])).toEqual([
      ['idle', 8],
      ['hype', 5],
      ['skip', 3],
      ['dj', 6],
      ['booth', 8],
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
    [
      'wrong size',
      async () => [{ filename: 'x.png', data: await makeSheet({ w: 1024, h: 1024, rows: [1] }) }],
      'size_unsupported',
      /1024 × 1024, and we couldn’t find rows of animation frames in it\./,
    ],
    ['no alpha', async () => [{ filename: 'x.png', data: await makeSheet({ rows: [8], alpha: false }) }], 'no_alpha'],
    ['jpeg', async () => [{ filename: 'x.png', data: await makeSheet({ rows: [8], format: 'jpeg', alpha: false }) }], 'format_unsupported'],
    ['empty idle row', async () => [{ filename: 'x.png', data: await makeSheet({ rows: [0, 4, 4] }) }], 'idle_empty'],
    [
      'zip path traversal',
      async () => [{ filename: 'k.zip', data: makeKit({ 'pet.json': '{"spritesheet":"s.png"}', '../s.png': await makeSheet({ rows: [8] }) }) }],
      'zip_nested',
    ],
    ['zip nested folder', async () => [{ filename: 'k.zip', data: makeKit({ 'pet/pet.json': '{}', 'pet/s.png': Buffer.from('x') }) }], 'zip_nested'],
    [
      'zip extra files',
      async () => [
        { filename: 'k.zip', data: makeKit({ 'pet.json': '{"spritesheet":"s.png"}', 's.png': await makeSheet({ rows: [8] }), 'run.sh': 'echo hi' }) },
      ],
      'zip_extra_files',
    ],
    ['zip without pet.json', async () => [{ filename: 'k.zip', data: makeKit({ 's.png': Buffer.from('x') }) }], 'pet_json_missing'],
    [
      'huge pet.json',
      async () => [{ filename: 'k.zip', data: makeKit({ 'pet.json': JSON.stringify({ name: 'x'.repeat(70_000) }), 's.png': Buffer.from('x') }) }],
      'pet_json_too_large',
    ],
    [
      'bad pet.json',
      async () => [
        { filename: 'pet.json', data: Buffer.from('{nope') },
        { filename: 's.png', data: await makeSheet({ rows: [8] }) },
      ],
      'pet_json_invalid',
    ],
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

  it('reads the grid of a non-standard sheet from its art, or takes the owner’s grid', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const data = await makeSheet({ w: 1536, h: 1040, rows: [8, 4, 4, 4, 4] });
    const r1 = (await upload(u, [{ filename: 'x.png', data }], '?dryRun=true')).json();
    expect(r1).toMatchObject({ ok: true, frameCounts: { idle: 8, 'running-right': 4 } });
    const r2 = (await upload(u, [{ filename: 'x.png', data }], '?dryRun=true&cols=8&rows=5')).json();
    expect(r2.ok).toBe(true);
  });

  it('accepts sheets of any size, cutting along the gaps between figures even when rows are uneven', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    // A v2 sheet saved at about two-thirds size (1027 × 1531).
    const full = await makeSheet({ h: 2288, rows: [...V1_ROWS, 6, 8] });
    const small = await sharp(full).resize(1027, 1531, { fit: 'fill' }).png().toBuffer();
    const r = (await upload(u, [{ filename: 'small.png', data: small }], '?dryRun=true')).json();
    expect(r).toMatchObject({ ok: true, detectedSize: { w: 1027, h: 1531 } });
    expect(r.frameCounts).toMatchObject({ idle: 8, running: 6, waiting: 2 });

    // Like an image-model sheet: 10 rows (not ChatGPT's 9 or 11) of wide frames, unevenly spaced,
    // at the same proportions as a v2 sheet — the size alone would suggest 11 rows.
    const W = 1027;
    const H = 1531;
    const frames = [6, 8, 8, 4, 5, 8, 6, 6, 8, 8];
    const tops = [6, 158, 304, 446, 590, 742, 892, 1043, 1196, 1356];
    const raw = Buffer.alloc(W * H * 4);
    frames.forEach((n, r) => {
      for (let f = 0; f < n; f++)
        for (let y = tops[r]!; y < tops[r]! + 130; y++) for (let x = f * 128 + 18; x < f * 128 + 110; x++) raw[(y * W + x) * 4 + 3] = 255;
    });
    const uneven = await sharp(raw, { raw: { width: W, height: H, channels: 4 } })
      .png()
      .toBuffer();
    const u2 = (await upload(u, [{ filename: 'gen.png', data: uneven }], '?dryRun=true')).json();
    expect(u2.ok).toBe(true);
    expect(u2.frameCounts).toMatchObject({ idle: 6, 'running-right': 8, waving: 4, jumping: 5, failed: 8, waiting: 6, running: 6 });
  });

  it('finds each figure on its own, so rows can differ in frame count, spacing and offset', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    // No common grid: every row has its own frame count, spacing and starting point.
    const W = 1200;
    const H = 900;
    const rows = [
      { n: 6, start: 10, step: 150 },
      { n: 8, start: 60, step: 140 },
      { n: 4, start: 200, step: 230 },
      { n: 5, start: 30, step: 170 },
      { n: 7, start: 90, step: 150 },
    ];
    const raw = Buffer.alloc(W * H * 4);
    rows.forEach(({ n, start, step }, r) => {
      for (let f = 0; f < n; f++)
        for (let y = r * 180 + 25; y < r * 180 + 155; y++) for (let x = start + f * step; x < start + f * step + 95; x++) raw[(y * W + x) * 4 + 3] = 255;
    });
    const sheet = await sharp(raw, { raw: { width: W, height: H, channels: 4 } })
      .png()
      .toBuffer();
    const r = (await upload(u, [{ filename: 'free.png', data: sheet }], '?dryRun=true')).json();
    expect(r.ok).toBe(true);
    expect(r.frameCounts).toMatchObject({ idle: 6, 'running-right': 8, waving: 5, jumping: 7 });
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

describe('choosing views (which sheet row plays where)', () => {
  it('lists every view and rebuilds the avatar from the original with the owner’s picks', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const rows = [...V1_ROWS, 6, 8]; // v2: two extra rows (e.g. back views)
    const saved = (await upload(u, [{ filename: 'sheet.webp', data: await makeSheet({ h: 2288, rows, format: 'webp' }) }], '?rightsConfirmed=true')).json();
    const id = saved.avatar.id;
    await u.req('PUT', '/v1/me/avatar', { avatarId: id });

    // Avatars saved before views existed get them built on first look.
    await t.ctx.db.update(avatars).set({ views: null, viewsUrl: null, choices: null }).where(eq(avatars.id, id));
    const v = (await u.req('GET', `/v1/avatars/${id}/views`)).json();
    expect(v.views.map((x: { row: number }) => x.row)).toEqual(rows.flatMap((n, i) => (n ? [i] : [])));
    expect(v.views.at(-1)).toMatchObject({ row: 10, name: 'row-11', frames: 8 });
    expect(v.choices).toMatchObject({ idle: 0, booth: 0, dj: 7 });
    expect((await t.app.inject({ method: 'GET', url: v.sheetUrl })).headers['content-type']).toBe('image/webp');
    // Floor and booth share one sheet row.
    const at = (a: { rows: { state: string; at?: number }[] }, s: string) => a.rows.find((r) => r.state === s)!.at;
    expect(at(v.avatar, 'booth')).toBe(at(v.avatar, 'idle'));

    // Back view on the floor, front view at the booth; a pick past the sheet falls back.
    const set = (await u.req('PUT', `/v1/avatars/${id}/views`, { choices: { idle: 9, booth: 0, dj: 10, hype: 40 } })).json();
    expect(set.choices).toMatchObject({ idle: 9, booth: 0, dj: 10, hype: 4 });
    expect(at(set.avatar, 'idle')).not.toBe(at(set.avatar, 'booth'));
    expect(set.avatar.rows.find((r: { state: string }) => r.state === 'dj').frames).toBe(8);
    expect(set.avatar.sheetUrl).not.toBe(saved.avatar.sheetUrl);
    expect(set.avatar.status).toBe('pending'); // same reviewed art, so the review status stays
    // Unchanged states keep their picks on the next save.
    expect((await u.req('PUT', `/v1/avatars/${id}/views`, { choices: { wave: 3 } })).json().choices).toMatchObject({ idle: 9, dj: 10, wave: 3 });

    // The new sheet is what the owner wears.
    const me = (await u.req('GET', '/v1/me')).json();
    expect(at(me.avatar, 'idle')).toBe(at(set.avatar, 'idle'));

    // Only the owner, and only uploaded avatars.
    const bob = await login(t, 'bob');
    expect((await bob.req('GET', `/v1/avatars/${id}/views`)).statusCode).toBe(404);
    expect((await bob.req('PUT', `/v1/avatars/${id}/views`, { choices: { idle: 1 } })).statusCode).toBe(404);
    expect((await u.req('GET', '/v1/avatars/preset-bolt/views')).statusCode).toBe(404);
  });
});

describe('frames don’t bleed into each other', () => {
  // A 2 × 2 sheet of 20 × 20 cells.
  const W = 40;
  const paint = (raw: Buffer, x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) raw[(y * W + x) * 4 + 3] = 255;
  };
  const filled = (raw: Buffer, x: number, y: number) => raw[(y * W + x) * 4 + 3]! > 0;

  it('clears a neighbour’s feet, hat or elbow from each cell but keeps the figure and its sparkles', () => {
    const raw = Buffer.alloc(W * W * 4);
    paint(raw, 4, 3, 15, 17); // top-left: figure
    paint(raw, 1, 9, 2, 10); // …and a sparkle beside it, not touching the edge
    paint(raw, 6, 25, 14, 37); // bottom-left: figure
    paint(raw, 6, 20, 8, 21); // …with the feet of the frame above poking in at the top
    paint(raw, 39, 5, 39, 6); // top-right: only an elbow from the next sheet column
    paint(raw, 25, 30, 34, 39); // bottom-right: a figure that itself touches the bottom edge
    const out = isolateCells(raw, W, { version: null, cols: 2, rows: 2 }, 20, 20);
    expect(filled(out, 10, 10)).toBe(true);
    expect(filled(out, 1, 9)).toBe(true);
    expect(filled(out, 10, 30)).toBe(true);
    expect(filled(out, 7, 20)).toBe(false);
    expect(filled(out, 39, 5)).toBe(false);
    expect(filled(out, 30, 39)).toBe(true);
    expect(filled(raw, 7, 20)).toBe(true); // the input is untouched
  });

  it('rebuilds avatars made by an older sheet builder at boot, keeping view picks', async () => {
    t = await createTestApp();
    const u = await login(t, 'alice');
    const saved = (
      await upload(u, [{ filename: 's.webp', data: await makeSheet({ h: 2288, rows: [...V1_ROWS, 6, 8], format: 'webp' }) }], '?rightsConfirmed=true')
    ).json();
    const id = saved.avatar.id;
    await u.req('PUT', `/v1/avatars/${id}/views`, { choices: { idle: 9 } });
    await t.ctx.db.update(avatars).set({ build: 1 }).where(eq(avatars.id, id));
    expect(await refreshAvatars(t.ctx)).toBe(1);
    const row = await t.ctx.db.query.avatars.findFirst({ where: eq(avatars.id, id) });
    expect(row).toMatchObject({ build: AVATAR_BUILD, choices: expect.objectContaining({ idle: 9 }) });
    expect(await refreshAvatars(t.ctx)).toBe(0);
  });
});

describe('defaults a site admin offers to everyone', () => {
  it('lets an admin make an upload a default anyone can pick, and take it back', async () => {
    t = await createTestApp({ cfg: { ADMIN_SPOTIFY_IDS: 'admin' } });
    const admin = await login(t, 'admin');
    const bob = await login(t, 'bob');
    const bobsPreset = (await bob.req('GET', '/v1/me')).json().avatar.id;
    const robot = (await upload(admin, [{ filename: 'robot.png', data: await makeSheet({ rows: V1_ROWS }) }], '?rightsConfirmed=true&name=Robot')).json()
      .avatar;
    expect(robot).toMatchObject({ status: 'pending', featured: false });
    // Not offered yet: Bob can't see or pick it.
    expect((await bob.req('GET', '/v1/avatars/presets')).json().some((a: { id: string }) => a.id === robot.id)).toBe(false);
    expect((await bob.req('PUT', '/v1/me/avatar', { avatarId: robot.id })).statusCode).toBe(404);
    // Only admins can offer avatars, and only their own uploads.
    expect((await bob.req('PUT', `/v1/admin/avatars/${robot.id}/featured`, { featured: true })).statusCode).toBe(403);

    const featured = (await admin.req('PUT', `/v1/admin/avatars/${robot.id}/featured`, { featured: true })).json();
    expect(featured).toMatchObject({ featured: true, status: 'approved' });
    const presets = (await bob.req('GET', '/v1/avatars/presets')).json();
    expect(presets.at(-1)).toMatchObject({ id: robot.id, name: 'Robot', featured: true });
    expect((await bob.req('PUT', '/v1/me/avatar', { avatarId: robot.id })).json().avatar.id).toBe(robot.id);

    // Defaults don't use up the admin's own upload slots.
    for (let i = 0; i < 5; i++)
      expect((await upload(admin, [{ filename: `s${i}.png`, data: await makeSheet({ rows: [i + 1] }) }], '?rightsConfirmed=true')).json().avatar).toBeTruthy();

    // Taking it back: Bob returns to his preset; the admin keeps theirs.
    await admin.req('PUT', '/v1/me/avatar', { avatarId: robot.id });
    await admin.req('PUT', `/v1/admin/avatars/${robot.id}/featured`, { featured: false });
    expect((await bob.req('GET', '/v1/me')).json().avatar.id).toBe(bobsPreset);
    expect((await admin.req('GET', '/v1/me')).json().avatar.id).toBe(robot.id);
    expect((await bob.req('GET', '/v1/avatars/presets')).json().some((a: { id: string }) => a.id === robot.id)).toBe(false);
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
    expect(bobSnap.members.find((m: { user: { id: string } }) => m.user.id === alice.id)).toMatchObject({
      avatarHidden: true,
      user: { avatar: { kind: 'preset' } },
    });

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

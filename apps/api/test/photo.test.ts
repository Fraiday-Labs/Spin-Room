import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { multipart } from './fixtures/pets.js';
import { createTestApp, login, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
afterEach(async () => t?.close());

async function upload(u: TestUser, data: Buffer, filename = 'me.jpg') {
  const mp = multipart([{ filename, data, type: 'image/jpeg' }]);
  return t.app.inject({ method: 'PUT', url: '/v1/me/photo', payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${u.token}` } });
}

/** A 1200×800 JPEG carrying EXIF (camera make) metadata. */
const photo = (color: string) =>
  sharp({ create: { width: 1200, height: 800, channels: 3, background: color } })
    .jpeg()
    .withExif({ IFD0: { Make: 'SecretCam' } })
    .toBuffer();

describe('profile photo', () => {
  it('stores a 256×256 WebP without metadata, replaces and removes it', async () => {
    t = await createTestApp();
    const alice = await login(t, 'alice', { displayName: 'Alice' });
    expect((await alice.req('GET', '/v1/me')).json().photoUrl).toBeNull();

    const res = await upload(alice, await photo('#ff2bd6'));
    expect(res.statusCode, res.body).toBe(200);
    const url1: string = res.json().photoUrl;
    expect(url1).toMatch(/\/photos\/.+\.webp$/);
    const key1 = url1.slice(url1.indexOf('photos/'));
    const stored = (await t.ctx.storage.get(key1))!;
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(['webp', 256, 256, undefined]);

    // A new photo replaces the old file.
    const url2: string = (await upload(alice, await photo('#3de2ff'))).json().photoUrl;
    expect(url2).not.toBe(url1);
    expect(await t.ctx.storage.exists(key1)).toBe(false);

    const removed = (await alice.req('DELETE', '/v1/me/photo')).json();
    expect(removed.photoUrl).toBeNull();
    expect(await t.ctx.storage.exists(url2.slice(url2.indexOf('photos/')))).toBe(false);
  });

  it('rejects files that aren’t images', async () => {
    t = await createTestApp();
    const bob = await login(t, 'bob');
    const res = await upload(bob, Buffer.from('definitely not a picture'), 'notes.txt');
    expect(res.json().code).toBe('unsupported_image');
  });
});

import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { newUserPage, uid } from './helpers';

// Use sharp from the API package to make a ChatGPT-style v1 sheet (1536 × 1872, 192 × 208 cells).
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const sharp = require('sharp') as (input: Buffer, opts: { raw: { width: number; height: number; channels: 4 } }) => { png(): { toBuffer(): Promise<Buffer> } };

async function sheet(w: number, h: number, rows: number[]) {
  const raw = Buffer.alloc(w * h * 4, 0);
  rows.forEach((frames, r) => {
    for (let f = 0; f < frames; f++)
      for (let y = r * 208 + 40; y < r * 208 + 160; y++)
        for (let x = f * 192 + 40; x < f * 192 + 150; x++) {
          const i = (y * w + x) * 4;
          raw[i] = 255;
          raw[i + 1] = 80 + r * 20;
          raw[i + 2] = 160;
          raw[i + 3] = 255;
        }
  });
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

test('import a ChatGPT pet sheet, preview every state, confirm rights and use it', async ({ browser }) => {
  const p = await newUserPage(browser, uid('petowner'));
  await p.goto('/profile/avatar');
  await p.getByTestId('avatar-file').setInputFiles({ name: 'mochi.png', mimeType: 'image/png', buffer: await sheet(1536, 1872, [8, 6, 6, 4, 5, 3, 2, 6, 0]) });
  await expect(p.getByTestId('avatar-preview').locator('figure')).toHaveCount(7);
  await expect(p.getByTestId('save-avatar')).toBeDisabled();
  await p.getByTestId('rights').check();
  await p.getByTestId('save-avatar').click();
  await expect(p.getByRole('status')).toContainText(/Saved/);
});

test('invalid sheets get a named error and fix', async ({ browser }) => {
  const p = await newUserPage(browser, uid('badpet'));
  await p.goto('/profile/avatar');
  await p.getByTestId('avatar-file').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: await sheet(1024, 1024, [1]) });
  await expect(p.getByTestId('avatar-error')).toContainText('This image is 1024 × 1024. ChatGPT pet sheets are 1536 × 1872 or 1536 × 2288 — use Download sprite kit in ChatGPT.');
});

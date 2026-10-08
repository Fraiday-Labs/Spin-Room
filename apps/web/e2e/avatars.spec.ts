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
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}

test('import a ChatGPT pet sheet, preview every state, confirm rights and use it', async ({ browser }) => {
  const p = await newUserPage(browser, uid('petowner'));
  await p.goto('/profile/avatar');
  await p.getByTestId('avatar-file').setInputFiles({ name: 'mochi.png', mimeType: 'image/png', buffer: await sheet(1536, 1872, [8, 6, 6, 4, 5, 3, 2, 6, 0]) });
  await expect(p.getByTestId('avatar-preview').locator('figure')).toHaveCount(8);
  await expect(p.getByTestId('save-avatar')).toBeDisabled();
  await p.getByTestId('rights').check();
  await p.getByTestId('save-avatar').click();
  await expect(p.getByRole('status')).toContainText(/Saved/);
});

test('invalid sheets get a named error and fix', async ({ browser }) => {
  const p = await newUserPage(browser, uid('badpet'));
  await p.goto('/profile/avatar');
  await p.getByTestId('avatar-file').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: await sheet(1024, 1024, [1]) });
  await expect(p.getByTestId('avatar-error')).toContainText(
    'This image is 1024 × 1024, and we couldn’t find rows of animation frames in it. Upload a sprite sheet with the frames in rows on a transparent background, like ChatGPT’s Download sprite kit.',
  );
});

test('pick which still pose of an uploaded sheet shows on the floor, at the booth and more', async ({ browser }) => {
  const p = await newUserPage(browser, uid('viewpicker'));
  await p.goto('/profile/avatar');
  // A v2 sheet: the nine standard rows plus two extra ones (like back views).
  await p
    .getByTestId('avatar-file')
    .setInputFiles({ name: 'kid.png', mimeType: 'image/png', buffer: await sheet(1536, 2288, [6, 8, 8, 4, 5, 8, 6, 6, 6, 6, 8]) });
  await p.getByTestId('rights').check();
  await p.getByTestId('save-avatar').click();
  await expect(p.getByRole('status')).toContainText(/Choose poses/);

  // Every figure on the sheet is its own still pose: 6+8+8+4+5+8+6+6+6+6+8 = 71.
  await p.getByRole('button', { name: /Choose poses for/ }).click();
  const editor = p.getByTestId('views-editor');
  await expect(editor).toContainText('Your sheet has 71 poses');
  const floor = editor.getByRole('radiogroup', { name: 'On the dance floor' });
  await expect(floor.getByRole('radio')).toHaveCount(71);
  await expect(floor.getByRole('radio', { name: /: Pose 1$/ })).toHaveAttribute('aria-checked', 'true');
  await expect(editor.getByTestId('save-views')).toBeDisabled();

  // The first figure of row 10 on the floor; the 3rd figure of row 11 for DJing.
  await floor.getByRole('radio', { name: /: Pose 58$/ }).click();
  await editor
    .getByRole('radiogroup', { name: 'DJing (your track is playing)' })
    .getByRole('radio', { name: /: Pose 66$/ })
    .click();
  await editor.getByTestId('save-views').click();
  await expect(editor.getByRole('status')).toContainText('Saved');

  // Star favourites: each place then offers just those (plus what it shows now).
  const favs = editor.getByRole('group', { name: 'Favorite poses' });
  for (const n of [58, 66, 25]) await favs.getByRole('button', { name: `Favorite: Pose ${n}`, exact: true }).click();
  await expect(editor.getByTestId('fav-count')).toContainText('3 of 5');
  await expect(floor.getByRole('radio')).toHaveCount(3);
  await editor.getByTestId('show-all-views').check();
  await expect(floor.getByRole('radio')).toHaveCount(71);
  await editor.getByTestId('show-all-views').uncheck();
  await editor.getByTestId('save-views').click();
  await expect(editor.getByRole('status')).toContainText('Saved');

  // The picks stick, and the avatar shows different stills on the floor and at the booth.
  await p.reload();
  await p.getByRole('button', { name: /Choose poses for/ }).click();
  await expect(p.getByRole('radiogroup', { name: 'On the dance floor' }).getByRole('radio', { name: /: Pose 58$/ })).toHaveAttribute('aria-checked', 'true');
  await expect(p.getByTestId('fav-count')).toContainText('3 of 5');
  await expect(p.getByRole('radiogroup', { name: 'On the dance floor' }).getByRole('radio')).toHaveCount(3);
  const me = await p.evaluate(async () => (await fetch('/v1/me')).json());
  const at = (s: string) => me.avatar.rows.find((r: { state: string }) => r.state === s).at;
  expect(at('idle')).not.toBe(at('booth'));
  expect(me.avatar.rows.every((r: { frames: number }) => r.frames === 1)).toBe(true);
});

test('a site admin makes an uploaded avatar a default that everyone can pick', async ({ browser }) => {
  const admin = await newUserPage(browser, 'e2e-site-admin');
  await admin.goto('/profile/avatar');
  await admin
    .getByTestId('avatar-file')
    .setInputFiles({ name: 'robot.png', mimeType: 'image/png', buffer: await sheet(1536, 1872, [6, 6, 6, 4, 5, 3, 2, 6, 0]) });
  const name = `Robot ${uid('')}`;
  await admin.getByLabel('Name').fill(name);
  await admin.getByTestId('rights').check();
  await admin.getByTestId('save-avatar').click();
  await expect(admin.getByRole('status')).toContainText(/Saved/);
  await admin
    .getByRole('button', { name: `Delete “${name}”` })
    .locator('xpath=..')
    .getByRole('button', { name: 'Make default for everyone' })
    .click();
  await expect(admin.getByRole('status')).toContainText(`“${name}” is now a default everyone can pick.`);

  const friend = await newUserPage(browser, uid('picker'));
  await friend.goto('/profile/avatar');
  const choice = friend.getByRole('radiogroup', { name: 'Avatar' }).getByRole('radio', { name: name });
  await choice.click();
  await expect(choice).toHaveAttribute('aria-checked', 'true');
  // Regular members don't get the admin button.
  await expect(friend.getByRole('button', { name: 'Make default for everyone' })).toHaveCount(0);
});

test('avatar actions show only for the avatar you have selected', async ({ browser }) => {
  const p = await newUserPage(browser, uid('twopets'));
  await p.goto('/profile/avatar');
  for (const name of ['Alpha', 'Beta']) {
    await p
      .getByTestId('avatar-file')
      .setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: await sheet(1536, 1872, [6, 6, 6, 4, 5, 3, 2, 6, 0]) });
    await p.getByLabel('Name').fill(name);
    await p.getByTestId('rights').check();
    await p.getByTestId('save-avatar').click();
    await expect(p.getByRole('status')).toContainText(/Saved/);
  }
  // Wearing Beta (saved last): only Beta's actions.
  const actions = p.getByTestId('avatar-actions');
  await expect(actions).toContainText('Choose poses for “Beta”');
  await expect(actions).toContainText('Delete “Beta”');
  await expect(p.getByText(/“Alpha”/)).toHaveCount(0);

  // Switch to Alpha: the actions follow.
  await p.getByRole('radiogroup', { name: 'Avatar' }).getByRole('radio', { name: 'Alpha' }).click();
  await expect(actions).toContainText('Choose poses for “Alpha”');
  await expect(p.getByText(/“Beta”/)).toHaveCount(0);

  // A built-in avatar has none.
  await p.getByRole('radiogroup', { name: 'Avatar' }).getByRole('radio').first().click();
  await expect(p.getByTestId('avatar-actions')).toHaveCount(0);
});

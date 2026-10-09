import { expect, test } from '@playwright/test';
import { addTrack, newUserPage, run, signInViaUi, uid } from './helpers';

test.describe('Journey 1 + 2: create, invite, join and DJ', () => {
  test('host creates an invite-only room, a friend joins by link, hears the live position and DJs', async ({ page, browser }) => {
    // ---- Journey 1: sign in, create room, copy invite, start speaker
    const host = uid('host');
    await signInViaUi(page, host);
    await expect(page).toHaveURL(/\/lobby/);
    await page.getByTestId('open-create-room').click();
    await page.getByTestId('room-name').fill(`Friday ${host}`);
    await page.getByLabel('Who can join').selectOption('invite_only');
    await page.getByTestId('create-room').click();
    await expect(page).toHaveURL(/\/r\/friday-/);
    await page.getByTestId('room-menu').click();
    await page.getByTestId('share-room').click();
    await page.getByRole('button', { name: 'Create a one-time invite' }).click();
    const inviteUrl = (await page.locator('code', { hasText: '/invite/' }).textContent())!;
    expect(inviteUrl).toMatch(/\/invite\/inv_/);
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByTestId('start-speaker').click();
    await expect(page.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');

    // Host adds two tracks and steps up; the first plays.
    await addTrack(page, 'Neon Tide');
    await addTrack(page, 'Booth Lights');
    await page.getByRole('tab', { name: 'DJ queue' }).click();
    await page.getByTestId('queue-toggle').click();
    await expect(page.getByTestId('np-title')).toHaveText('Neon Tide');
    await expect(page.getByTestId('marquee')).toContainText('Neon Tide');
    await expect(page.getByTestId('dj-slot-0')).toBeVisible();

    // ---- Journey 2: friend opens the invite link and signs in
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const friend = await ctx.newPage();
    const path = new URL(inviteUrl).pathname;
    await friend.goto(path);
    // Never used Spinroom: one button to Spotify's sign-in (test sign-in here), then straight into the room.
    await friend.getByTestId('invite-sign-in').click();
    await expect(friend).toHaveURL(/\/dev-login/);
    await friend.getByLabel('Spotify user ID').fill(uid('friend'));
    await friend.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(friend).toHaveURL(/\/r\/friday-[^?]*\?speaker=1$/);
    await expect(friend.getByTestId('stage')).toBeVisible();
    await expect(friend.getByTestId('start-speaker')).toBeFocused();
    await expect(friend.getByTestId('np-title')).toHaveText('Neon Tide');

    // Late join: audio starts at the live position.
    await friend.waitForTimeout(2000);
    await friend.getByTestId('start-speaker').click();
    await expect(friend.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
    const state = () =>
      friend.evaluate(async () => {
        const sp = (window as unknown as { __speaker: { player: { getState(): Promise<{ positionMs: number; uri: string } | null> } } }).__speaker;
        return sp.player.getState();
      });
    await expect.poll(async () => (await state())?.uri ?? null).toMatch(/^spotify:track:/);
    const pos = await state();
    expect(pos!.positionMs).toBeGreaterThan(1500);

    // Friend joins the DJ queue: empty set → My set tab, search, add, then join.
    await friend.getByRole('tab', { name: 'DJ queue' }).click();
    await friend.getByTestId('queue-toggle').click();
    await expect(friend.getByRole('tab', { name: 'My set' })).toHaveAttribute('aria-selected', 'true');
    await addTrack(friend, 'Pixel Rain');
    await friend.getByRole('tab', { name: 'DJ queue' }).click();
    await friend.getByTestId('queue-toggle').click();
    await expect(friend.getByTestId('dj-slot-1')).toBeVisible();

    // Friend votes Hype on the host's spin; the host sees it within a second.
    await friend.getByTestId('vote-hype').click();
    await expect(friend.getByTestId('vote-hype')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('vote-hype')).toContainText('1', { timeout: 2000 });

    // Host skips their own spin → the friend's turn: their track plays.
    await page.getByTestId('skip-spin').click();
    await expect(friend.getByTestId('np-title')).toHaveText('Pixel Rain');
    await expect(page.getByTestId('announcer')).toContainText('Now playing Pixel Rain');
    await ctx.close();
  });

  test('Free accounts are turned away at sign-in and told why', async ({ page }) => {
    await signInViaUi(page, uid('free'), { premium: false });
    await expect(page).toHaveURL(/\/connect\?error=premium_required/);
    await expect(page.getByRole('alert')).toContainText('Spinroom needs Spotify Premium');
    // Not signed in: the rooms page asks for sign-in.
    await page.goto('/lobby');
    await expect(page.getByRole('link', { name: 'Sign in with Spotify' }).first()).toBeVisible();
  });
});

test('reduced motion freezes the scene', async ({ browser }) => {
  const p = await newUserPage(browser, uid('calm'), undefined, { reducedMotion: 'reduce' });
  await p.goto('/lobby');
  await p.getByTestId('open-create-room').click();
  await p.getByTestId('room-name').fill(`Calm ${uid('r')}`);
  await p.getByTestId('create-room').click();
  await expect(p.getByTestId('stage')).toBeVisible();
  const anims = await p.evaluate(() => [...document.querySelectorAll('[data-testid=stage] img')].map((el) => getComputedStyle(el).animationName));
  expect(anims.every((a) => a === 'none')).toBe(true);
});

test('a hidden tab pauses scene animation but keeps the speaker live', async ({ browser }) => {
  const p = await newUserPage(browser, uid('bg'));
  await p.goto('/lobby');
  await p.getByTestId('open-create-room').click();
  await p.getByTestId('room-name').fill(`Bg ${uid('r')}`);
  await p.getByTestId('create-room').click();
  await p.getByTestId('start-speaker').click();
  await expect(p.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
  await p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(p.locator('.scene-paused')).toHaveCount(1);
  await p.waitForTimeout(16_000); // one heartbeat interval
  await expect(p.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
});

test('owners close, reopen and delete rooms, and listeners are told', async ({ page, browser }) => {
  const host = uid('closer');
  await signInViaUi(page, host);
  await expect(page).toHaveURL(/\/lobby/);
  const name = `Closing ${host}`;
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(name);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/closing-/);
  const roomPath = new URL(page.url()).pathname;

  // A friend is listening when the owner closes the room.
  const friend = await newUserPage(browser, uid('guest'));
  await friend.goto(roomPath);
  // Members get Share in the ⋮ menu, but not Settings.
  await friend.getByTestId('room-menu').click();
  await expect(friend.getByRole('menuitem', { name: 'Share' })).toBeVisible();
  await expect(friend.getByRole('menuitem', { name: 'Settings' })).toHaveCount(0);
  await friend.keyboard.press('Escape');
  await expect(friend.getByRole('tab', { name: 'DJ queue' })).toBeVisible();

  await page.getByTestId('room-menu').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Close room' }).click();
  await page.getByRole('alert').getByRole('button', { name: 'Close room' }).click();
  await expect(page).toHaveURL(/\/lobby/);
  await expect(friend.getByText('This room was closed by its owner')).toBeVisible();

  // The owner sees it as closed in their rooms, and can reopen it.
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen room' }).click();
  // Back as a normal room in your rooms.
  await expect(page.getByRole('link', { name: new RegExp(name) }).first()).toBeVisible();

  // Deleting needs the room's name typed in.
  await page.goto(`${roomPath}/settings`);
  await page.getByRole('button', { name: 'Delete room' }).click();
  const confirm = page.getByRole('button', { name: 'Delete forever' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Type the room name to confirm').fill(name);
  await confirm.click();
  await expect(page).toHaveURL(/\/lobby/);
  await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
  await friend.goto(roomPath);
  await expect(friend.getByText(/No room called/)).toBeVisible();
});

test('drag tracks in My set to reorder them (or use the arrow keys on the handle)', async ({ page }) => {
  await signInViaUi(page, uid('dragger'));
  await expect(page).toHaveURL(/\/lobby/);
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Drag ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/drag-/);
  for (const t of ['Neon Tide', 'Booth Lights', 'Pixel Rain']) await addTrack(page, t);
  const rows = page.getByTestId('my-set').locator('li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Neon Tide');

  // Drag the first track below the last one.
  const from = (await rows.nth(0).boundingBox())!;
  const to = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(from.x + 60, to.y + to.height - 2, { steps: 8 });
  await page.mouse.up();

  await expect(rows.nth(0)).toContainText('Booth Lights');
  await expect(rows.nth(2)).toContainText('Neon Tide');
  // It stuck on the server too.
  await page.reload();
  await page.getByRole('tab', { name: 'My set' }).click();
  await expect(page.getByTestId('my-set').locator('li').nth(2)).toContainText('Neon Tide');

  // No up/down arrow buttons; the drag handle moves a track with the arrow keys instead.
  const set = page.getByTestId('my-set');
  await expect(set.getByRole('button', { name: /^Move (up|down)$/ })).toHaveCount(0);
  await set.getByRole('button', { name: /^Reorder Neon Tide/ }).focus();
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/crate\//.test(r.url()));
  await page.keyboard.press('ArrowUp');
  await expect(set.locator('li').nth(1)).toContainText('Neon Tide');
  // Still on the handle once the server's reply has redrawn the list.
  await saved;
  await expect(set.getByRole('button', { name: /^Reorder Neon Tide/ })).toBeFocused();
});

test('a crash in one panel stays in that panel and is reported', async ({ browser }) => {
  const page = await newUserPage(browser, uid('crash'));
  const reports: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/v1/client-errors')) reports.push(r.postData() ?? '');
  });
  // A malformed set (no track) makes My set throw while rendering.
  await page.route('**/v1/rooms/*/crate', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ mode: 'local', playlist: null, position: 0, items: [{ id: 'x' }], notice: null }) }),
  );
  await page.goto('/lobby');
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Crash ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/crash-/);
  await page.getByRole('tab', { name: 'My set' }).click();
  await expect(page.getByText('The panel hit a problem.')).toBeVisible();
  await expect(page.getByTestId('stage')).toBeVisible();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByTestId('chat-log')).toBeVisible();
  await expect.poll(() => reports.length).toBeGreaterThan(0);
  expect(JSON.parse(reports[0]!)).toMatchObject({ where: 'rail:set', message: expect.stringContaining('TypeError') });
});

test('sending chat works in browsers where scrollIntoView returns a promise', async ({ browser }) => {
  const page = await newUserPage(browser, uid('chatter'));
  // Chrome 154+ returns a Promise from scrollIntoView; an effect that returned it crashed the chat panel.
  await page.addInitScript(() => {
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, ...args: Parameters<typeof orig>) {
      orig.apply(this, args);
      return Promise.resolve() as unknown as void;
    };
  });
  await page.goto('/lobby');
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Chat ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/chat-/);
  await page.getByRole('tab', { name: 'Chat' }).click();
  for (const text of ['hello', 'second message']) {
    await page.getByLabel('Chat message').fill(text);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('chat-log')).toContainText(text);
  }
  await page.getByRole('tab', { name: 'Up next' }).click();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByTestId('chat-log')).toContainText('second message');
  await expect(page.getByText('The panel hit a problem.')).toHaveCount(0);
});

test('a DJ can clear their whole set', async ({ page }) => {
  await signInViaUi(page, uid('clearer'));
  await expect(page).toHaveURL(/\/lobby/);
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Clear ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/clear-/);
  for (const t of ['Neon Tide', 'Booth Lights']) await addTrack(page, t);
  await page.getByRole('button', { name: 'Clear set' }).click();
  await expect(page.getByRole('alert')).toContainText('Remove all 2 tracks from your set?');
  await expect(page.getByRole('alert')).toContainText('playlist in Spotify is emptied too');
  await page.getByRole('alert').getByRole('button', { name: 'Clear set' }).click();
  await expect(page.getByTestId('my-set').locator('li')).toHaveCount(0);
  await expect(page.getByTestId('set-empty')).toBeVisible();
  // Still usable afterwards.
  await addTrack(page, 'Pixel Rain');
  await expect(page.getByTestId('my-set').locator('li')).toHaveCount(1);
});

test('search results show when a track is added, and offer Add again once it is removed', async ({ page }) => {
  await signInViaUi(page, uid('adder'));
  await expect(page).toHaveURL(/\/lobby/);
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Adder ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/adder-/);
  await addTrack(page, 'Neon Tide');
  const results = page.getByTestId('search-results');
  await expect(results.getByText('✓ Added')).toBeVisible();
  await expect(results.getByRole('button', { name: 'Add Neon Tide' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove Neon Tide' }).click();
  await expect(page.getByTestId('my-set').locator('li')).toHaveCount(0);
  await expect(results.getByRole('button', { name: 'Add Neon Tide' })).toBeVisible();
});

test('owners can close or delete a room from its card menu in the lobby', async ({ page }) => {
  const host = uid('lobbyowner');
  await signInViaUi(page, host);
  await expect(page).toHaveURL(/\/lobby/);
  const name = `Lobby ${host}`;
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(name);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/lobby-/);
  const slug = new URL(page.url()).pathname.split('/')[2]!;
  await page.getByRole('link', { name: 'Back to rooms' }).click();
  await expect(page).toHaveURL(/\/lobby/);

  const card = page.getByTestId(`room-card-${slug}`);
  // Your room shows once: in Your rooms, not again under public rooms.
  await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(1);
  // Close / Delete wait in the card's "⋯" menu, which Escape closes.
  await expect(card.getByRole('button', { name: 'Close room' })).toHaveCount(0);
  await card.getByRole('button', { name: `Options for ${name}` }).click();
  await expect(card.getByRole('menuitem', { name: 'Close room' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.getByRole('menu')).toHaveCount(0);
  await card.getByRole('button', { name: `Options for ${name}` }).click();
  await card.getByRole('menuitem', { name: 'Delete room' }).click();
  await card.getByLabel('Type the room name to confirm').fill(name);
  await card.getByRole('button', { name: 'Delete forever' }).click();
  await expect(card).toHaveCount(0);
});

test('a site admin can open settings in, and delete, a room someone else owns', async ({ page, browser }) => {
  const owner = await newUserPage(browser, uid('roomowner'));
  await owner.goto('/lobby');
  const name = `Admin cleanup ${run}`;
  await owner.getByTestId('open-create-room').click();
  await owner.getByTestId('room-name').fill(name);
  await owner.getByTestId('create-room').click();
  await expect(owner).toHaveURL(/\/r\/admin-cleanup-/);
  const slug = new URL(owner.url()).pathname.split('/')[2]!;

  // A regular member sees no Settings.
  const member = await newUserPage(browser, uid('member'));
  await member.goto(`/r/${slug}`);
  await expect(member.getByTestId('stage')).toBeVisible();
  await member.getByTestId('room-menu').click();
  await expect(member.getByRole('menuitem', { name: 'Settings' })).toHaveCount(0);

  await signInViaUi(page, 'e2e-site-admin');
  await page.goto(`/r/${slug}`);
  await page.getByTestId('room-menu').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Room settings' })).toBeVisible();
  await page.goto('/lobby');
  const card = page.getByTestId(`room-card-${slug}`);
  await card.getByRole('button', { name: `Options for ${name}` }).click();
  await card.getByRole('menuitem', { name: 'Delete room' }).click();
  await card.getByLabel('Type the room name to confirm').fill(name);
  await card.getByRole('button', { name: 'Delete forever' }).click();
  await expect(card).toHaveCount(0);
});

test('avatar choice lives only in the avatar studio, above the ChatGPT pet section', async ({ browser }) => {
  const page = await newUserPage(browser, uid('avatarfan'));
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'You', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
  await expect(page.getByText(/^Signed in as /)).toBeVisible();
  await expect(page.getByRole('heading', { name: /your avatar/i })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Avatar' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Avatar studio' }).click();
  await expect(page.getByRole('radiogroup', { name: 'Avatar' })).toBeVisible();
  const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
  expect(headings.indexOf('Your Avatar')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Your Avatar')).toBeLessThan(headings.indexOf('Bring your ChatGPT pet'));
});

test('rooms are created from the "Create +" modal', async ({ browser }) => {
  const page = await newUserPage(browser, uid('creator'));
  await page.goto('/lobby');
  await expect(page.getByRole('heading', { name: 'Your rooms' })).toBeVisible();
  await expect(page.getByText('Premium · can listen & DJ')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Open a room' })).toHaveCount(0);
  await expect(page.getByTestId('room-name')).toHaveCount(0);

  // Cancel and Escape both close it without creating anything…
  await page.getByTestId('open-create-room').click();
  await expect(page.getByRole('dialog', { name: 'Create a room' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByTestId('open-create-room').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // …and so does a tap outside it.
  await page.getByTestId('open-create-room').click();
  await expect(page.getByRole('dialog', { name: 'Create a room' })).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByTestId('open-create-room').click();
  await expect(page.getByTestId('room-name')).toBeFocused();
  await page.getByTestId('room-name').fill(`Modal ${run}`);
  await page.getByLabel('Who can join').selectOption('invite_only');
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/modal-/);
  await expect(page.getByTestId('stage')).toBeVisible();
});

test('"Anyone with the link" lets someone straight into an invite-only room, even before they sign in', async ({ page, browser }) => {
  const owner = await newUserPage(browser, uid('sharer'));
  await owner.goto('/lobby');
  await owner.getByTestId('open-create-room').click();
  await owner.getByTestId('room-name').fill(`Linky ${run}`);
  await owner.getByLabel('Who can join').selectOption('invite_only');
  await owner.getByTestId('create-room').click();
  await expect(owner).toHaveURL(/\/r\/linky-/);
  const roomPath = new URL(owner.url()).pathname;

  await owner.getByTestId('room-menu').click();
  await owner.getByTestId('share-room').click();
  const dialog = owner.getByRole('dialog', { name: /Share/ });
  await expect(dialog.getByLabel('General access')).toHaveValue('restricted');
  await expect(dialog.getByTestId('share-url')).toHaveValue(new RegExp(`${roomPath}$`));
  await dialog.getByLabel('General access').selectOption('link');
  await expect(dialog.getByTestId('share-url')).toHaveValue(/\?key=rk_/);
  const shareUrl = await dialog.getByTestId('share-url').inputValue();
  await expect(dialog.getByText('Anyone who has this link can join the room.')).toBeVisible();

  // A friend who isn't signed in opens the link, signs in, and lands in the room.
  await page.goto(new URL(shareUrl).pathname + new URL(shareUrl).search);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You’re invited to a Spinroom room');
  await page.getByTestId('link-sign-in').click();
  await expect(page).toHaveURL(/\/dev-login/);
  await page.getByLabel('Spotify user ID').fill(uid('linkfriend'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('stage')).toBeVisible();
  // In, and the key is no longer in the address bar.
  await expect(page).toHaveURL(new RegExp(`${roomPath}\\?speaker=1$`));

  // Resetting the link stops the old one working for newcomers.
  await dialog.getByRole('button', { name: 'Reset link' }).click();
  await expect(dialog.getByTestId('share-url')).not.toHaveValue(shareUrl);
  const latecomer = await newUserPage(browser, uid('late'));
  await latecomer.goto(new URL(shareUrl).pathname + new URL(shareUrl).search);
  await expect(latecomer.getByText(/That link no longer works/)).toBeVisible();
});

test('your chosen avatar is the one in the crowd after you step down from the booth', async ({ browser }) => {
  const page = await newUserPage(browser, uid('crowdfan'));
  await page.goto('/profile');
  await page.getByRole('link', { name: 'Avatar studio' }).click();
  const choice = page.getByRole('radio').nth(1);
  await choice.click();
  await expect(choice).toHaveAttribute('aria-checked', 'true');

  await page.goto('/lobby');
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Crowd ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/crowd-/);
  await addTrack(page, 'Neon Tide');
  await page.getByRole('tab', { name: 'DJ queue' }).click();
  await page.getByTestId('queue-toggle').click();
  const booth = page.getByTestId('dj-slot-0').locator('div[style*="background-image"]');
  await expect(booth).toBeVisible();
  const sheet = await booth.evaluate((el) => (el as HTMLElement).style.backgroundImage);

  await page.getByRole('button', { name: 'Step down from the booth' }).click();
  await expect(page.getByTestId('dj-slot-0')).toHaveCount(0);
  const inCrowd = page.locator('[data-testid^="crowd-"] div[style*="background-image"]');
  await expect(inCrowd).toHaveCount(1);
  expect(await inCrowd.evaluate((el) => (el as HTMLElement).style.backgroundImage)).toBe(sheet);
});

test('on a phone, the thumbs are on screen without scrolling and the header is one line', async ({ browser }) => {
  const page = await newUserPage(browser, uid('phoneuser'));
  await page.goto('/lobby');
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Pocket ${uid('')}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\//);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('vote-hype')).toBeInViewport();
  await expect(page.getByTestId('vote-skip')).toBeInViewport();
  await expect(page.locator('header').first().getByRole('link', { name: 'Spinroom home' })).toBeVisible();
  const header = await page.locator('header').first().boundingBox();
  expect(header!.height).toBeLessThan(64);
});

test('the lobby opens on rooms that are playing, with the track and DJ', async ({ browser }) => {
  const dj = await newUserPage(browser, uid('livedj'));
  await dj.goto('/lobby');
  const name = `Live ${run}`;
  await dj.getByTestId('open-create-room').click();
  await dj.getByTestId('room-name').fill(name);
  await dj.getByTestId('create-room').click();
  await expect(dj).toHaveURL(/\/r\/live-/);
  const slug = new URL(dj.url()).pathname.split('/')[2]!;
  await addTrack(dj, 'Neon Tide');
  await dj.getByRole('tab', { name: 'DJ queue' }).click();
  await dj.getByTestId('queue-toggle').click();
  await expect(dj.getByTestId('np-title')).toHaveText('Neon Tide');

  // Someone else browsing the lobby sees it first, under Live now.
  const guest = await newUserPage(browser, uid('browser'));
  await guest.goto('/lobby');
  const live = guest.getByRole('region', { name: 'Live now' });
  const card = live.getByTestId(`room-card-${slug}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Neon Tide');
  // The DJ's name, in its own column.
  await expect(card.getByRole('cell', { name: /livedj/i })).toBeVisible();
  // …and only there.
  await expect(guest.getByTestId(`room-card-${slug}`)).toHaveCount(1);
  await card.click();
  await expect(guest).toHaveURL(new RegExp(`/r/${slug}`));
});

test('the DJ can pause and resume the track for everyone', async ({ page, browser }) => {
  await signInViaUi(page, uid('pauser'));
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Pause ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/pause-/);
  const roomPath = new URL(page.url()).pathname;
  await addTrack(page, 'Neon Tide');
  await page.getByRole('tab', { name: 'DJ queue' }).click();
  await page.getByTestId('queue-toggle').click();
  await expect(page.getByTestId('np-title')).toHaveText('Neon Tide');

  // A listener with a speaker on hears it.
  const friend = await newUserPage(browser, uid('hearer'));
  await friend.goto(roomPath);
  await friend.getByTestId('start-speaker').click();
  await expect(friend.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
  const playerPaused = () =>
    friend.evaluate(async () => {
      const sp = (window as unknown as { __speaker: { player: { getState(): Promise<{ paused: boolean } | null> } } }).__speaker;
      return (await sp.player.getState())?.paused ?? null;
    });
  await expect.poll(playerPaused).toBe(false);
  // Only the DJ (or a moderator) gets the button.
  await expect(friend.getByTestId('pause-spin')).toHaveCount(0);

  await page.getByRole('button', { name: 'Pause the track for everyone' }).click();
  await expect(friend.getByTestId('np-paused')).toBeVisible();
  await expect(friend.getByTestId('marquee')).toContainText('PAUSED');
  await expect.poll(playerPaused).toBe(true);
  const heldAt = await friend.getByRole('progressbar', { name: 'Track progress' }).getAttribute('aria-valuenow');
  await friend.waitForTimeout(2500);
  expect(await friend.getByRole('progressbar', { name: 'Track progress' }).getAttribute('aria-valuenow')).toBe(heldAt);

  await page.getByRole('button', { name: 'Resume the track for everyone' }).click();
  await expect(friend.getByTestId('np-paused')).toHaveCount(0);
  await expect.poll(playerPaused).toBe(false);
});

test('the DJ can skip forward, and go back to the song before', async ({ page }) => {
  await signInViaUi(page, uid('backer'));
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Back ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/back-/);
  for (const t of ['Neon Tide', 'Booth Lights', 'Pixel Rain']) await addTrack(page, t);
  await page.getByRole('tab', { name: 'DJ queue' }).click();
  await page.getByTestId('queue-toggle').click();
  await expect(page.getByTestId('np-title')).toHaveText('Neon Tide');
  // Nothing before the first song yet.
  await expect(page.getByTestId('previous-spin')).toBeDisabled();
  // The Spotify logo opens the playing track in Spotify.
  await expect(page.getByRole('link', { name: 'Open in Spotify' })).toHaveAttribute('href', /^https:\/\/open\.spotify\.com\/track\//);

  await page.getByRole('button', { name: 'Skip to the next song' }).click();
  await expect(page.getByTestId('np-title')).toHaveText('Booth Lights');
  await page.getByRole('button', { name: /^Back to the previous song, Neon Tide/ }).click();
  await expect(page.getByTestId('np-title')).toHaveText('Neon Tide');
  // The interrupted song is back at the front of the set.
  await page.getByRole('tab', { name: 'My set' }).click();
  await expect(page.getByTestId('my-set').locator('li').filter({ hasText: 'Up next' })).toContainText('Booth Lights');
});

test('the speaker stops and starts again cleanly, and a second tab takes it over without asking', async ({ page }) => {
  await signInViaUi(page, uid('listener'));
  await page.getByTestId('open-create-room').click();
  await page.getByTestId('room-name').fill(`Speaker ${run}`);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/speaker-/);
  const roomPath = new URL(page.url()).pathname;
  const banner = page.getByTestId('speaker-banner');

  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(banner).toHaveAttribute('data-status', 'live');
  await page.getByRole('button', { name: 'Listening — stop' }).click();
  await expect(banner).toHaveAttribute('data-status', 'off');
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(banner).toHaveAttribute('data-status', 'live');

  // The same person opens the room in another tab: Listen there just works, and this tab steps back.
  const other = await page.context().newPage();
  await other.goto(roomPath);
  await other.getByRole('button', { name: 'Listen' }).click();
  await expect(other.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
  await expect(banner).toHaveAttribute('data-status', 'off');
  await expect(banner).toContainText('Your speaker moved to another tab.');

  // Reloading frees the speaker at once: starting again needs no takeover.
  await other.reload();
  await other.getByRole('button', { name: 'Listen' }).click();
  await expect(other.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
});

test('music keeps playing on other pages, with Listening in the top bar', async ({ page }) => {
  await signInViaUi(page, uid('wanderer'));
  await page.getByTestId('open-create-room').click();
  const name = `Wander ${run}`;
  await page.getByTestId('room-name').fill(name);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/wander-/);
  const roomPath = new URL(page.url()).pathname;
  for (const t of ['Neon Tide', 'Booth Lights']) await addTrack(page, t);
  await page.getByRole('tab', { name: 'DJ queue' }).click();
  await page.getByTestId('queue-toggle').click();
  await expect(page.getByTestId('np-title')).toHaveText('Neon Tide');
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
  const playing = () =>
    page.evaluate(async () => {
      const sp = (window as unknown as { __speaker: { player: { getState(): Promise<{ uri: string | null; paused: boolean } | null> } } }).__speaker;
      const st = await sp.player.getState();
      return st && !st.paused ? st.uri : null;
    });
  const neon = await playing();
  expect(neon).toMatch(/^spotify:track:/);

  // Off to the lobby (and then the profile): still playing, with the room and Listening up top.
  await page.getByRole('link', { name: 'Spinroom home' }).click();
  await expect(page).toHaveURL(/\/lobby/);
  const bar = page.getByTestId('now-listening');
  await expect(bar).toContainText(name);
  await expect(bar.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
  await page.getByTestId('user-menu').click();
  await page.getByRole('menuitem', { name: 'Profile' }).click();
  await expect(page).toHaveURL(/\/profile/);
  await expect(bar.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');
  expect(await playing()).toBe(neon);

  // The room carries on while we're away: the DJ skips from another tab, and this tab follows.
  const other = await page.context().newPage();
  await other.goto(roomPath);
  await other.getByRole('button', { name: 'Skip to the next song' }).click();
  await expect(other.getByTestId('np-title')).toHaveText('Booth Lights');
  await expect.poll(playing).not.toBe(neon);
  await other.close();

  // Back to the room by its name: the same speaker, still listening.
  await bar.getByRole('link', { name }).click();
  await expect(page).toHaveURL(new RegExp(roomPath));
  await expect(page.getByTestId('now-listening')).toHaveCount(0);
  await expect(page.getByTestId('speaker-banner')).toHaveAttribute('data-status', 'live');

  // Stopping from the top bar on another page ends it.
  await page.getByRole('link', { name: 'Spinroom home' }).click();
  await page.getByTestId('now-listening').getByRole('button', { name: 'Listening — stop' }).click();
  await expect(page.getByTestId('now-listening')).toHaveCount(0);
  expect(await playing()).toBeNull();
});

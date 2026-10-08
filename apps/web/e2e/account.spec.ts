import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { newUserPage, signInViaUi, uid } from './helpers';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const sharp = require('sharp') as (opts: { create: { width: number; height: number; channels: 3; background: string } }) => {
  jpeg(): { toBuffer(): Promise<Buffer> };
};

test('account menu: initial circle, photo upload, and items for regular members', async ({ browser }) => {
  const page = await newUserPage(browser, uid('david'), 'David Smith');
  await page.goto('/lobby');
  const menuButton = page.getByTestId('user-menu');
  await expect(menuButton.getByTestId('user-initial')).toHaveText('D');

  await menuButton.click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Profile', 'Sign out']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Upload a photo on the profile page; the header switches from the initial to the photo.
  await menuButton.click();
  await menu.getByRole('menuitem', { name: 'Profile' }).click();
  await expect(page).toHaveURL(/\/profile$/);
  const jpg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#ff2bd6' } })
    .jpeg()
    .toBuffer();
  await page.getByTestId('photo-file').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: jpg });
  await expect(page.getByRole('status')).toHaveText('Photo updated.');
  await expect(menuButton.locator('img')).toHaveAttribute('src', /photos\/.+\.webp$/);
  await expect(menuButton.getByTestId('user-initial')).toHaveCount(0);

  await page.getByRole('button', { name: 'Remove photo' }).click();
  await expect(page.getByRole('status')).toHaveText('Photo removed.');
  await expect(menuButton.getByTestId('user-initial')).toHaveText('D');

  await menuButton.click();
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in with Spotify' }).first()).toBeVisible();
});

test('admins also get Admin and Integrations; Integrations is tabbed', async ({ page }) => {
  await signInViaUi(page, 'e2e-site-admin');
  await expect(page).toHaveURL(/\/lobby/);
  await page.getByTestId('user-menu').click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Profile', 'Admin', 'Integrations', 'Sign out']);
  await menu.getByRole('menuitem', { name: 'Integrations' }).click();

  await expect(page).toHaveURL(/\/integrations$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Integrations');
  const tabs = page.getByRole('tablist', { name: 'Integrations' }).getByRole('tab');
  await expect(tabs).toHaveText(['Remote server', 'Local server', 'Slack']);
  await expect(page.getByRole('tab', { name: 'Remote server' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Remote MCP server (recommended)' })).toBeVisible();

  await page.getByRole('tab', { name: 'Local server' }).click();
  await expect(page).toHaveURL(/\/integrations\/local$/);
  await page.getByRole('button', { name: 'Get a one-time code' }).click();
  await expect(page.getByTestId('link-code')).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  await page.getByRole('tab', { name: 'Slack' }).click();
  await expect(page.getByRole('heading', { name: 'Slack', exact: true })).toBeVisible();
  await expect(page.getByTestId('slack-not-configured')).toBeVisible();
  await expect(page.getByText('/spinroom hype · /spinroom skip')).toBeVisible();

  // Old links still land on the page.
  await page.goto('/connect-agent');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Integrations');
});

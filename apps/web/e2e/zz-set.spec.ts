import { expect, test } from '@playwright/test';
import { addTrack, run, signInViaUi, uid } from './helpers';
test('settings when live', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 590 });
  await signInViaUi(page, uid('live'));
  await page.getByTestId('room-name').fill('Live ' + run);
  await page.getByTestId('create-room').click();
  await expect(page).toHaveURL(/\/r\/live-/);
  console.log(
    'before live, settings links:',
    await page.getByRole('link', { name: 'Settings' }).count(),
    await page.getByRole('link', { name: 'Settings' }).isVisible(),
  );
  await page.getByTestId('start-speaker').click();
  await addTrack(page, 'Neon Tide');
  await page.getByRole('tab', { name: 'DJ queue' }).click();
  await page.getByTestId('queue-toggle').click();
  await expect(page.getByTestId('np-title')).toHaveText('Neon Tide');
  await page.waitForTimeout(6000);
  const l = page.getByRole('link', { name: 'Settings' });
  console.log('live, settings links:', await l.count(), await l.isVisible().catch(() => 'n/a'), JSON.stringify(await l.boundingBox().catch(() => null)));
  await page.screenshot({
    path: '/tmp/claude-0/-home-user-Spin-Room/595bf465-5570-5c47-896d-37fc191bf1c9/scratchpad/live-header.png',
    clip: { x: 0, y: 0, width: 1000, height: 140 },
  });
  if (await l.count()) {
    await l.click();
    await page.waitForTimeout(1500);
    console.log('after click url', page.url(), (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));
  }
});

import { expect, type Browser, type Page } from '@playwright/test';

export const run = Math.random().toString(36).slice(2, 7);
export const uid = (name: string) => `${name}-${run}`;

/** Sign in through the real UI: Connect → test sign-in (fake Spotify) → callback. */
export async function signInViaUi(page: Page, userId: string, opts: { premium?: boolean } = {}) {
  await page.goto('/connect');
  await page.getByRole('button', { name: 'Continue to test sign-in' }).click();
  await expect(page).toHaveURL(/\/dev-login/);
  await page.getByLabel('Spotify user ID').fill(userId);
  if (opts.premium === false) await page.getByLabel('Premium account').uncheck();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Faster sign-in for supporting characters. */
export async function signInFast(page: Page, userId: string, displayName?: string) {
  await page.goto('/');
  await page.evaluate(
    async ([id, name]) => {
      const r = await fetch('/v1/auth/fake/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spotifyUserId: id, premium: true, ...(name ? { displayName: name } : {}) }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    [userId, displayName ?? null] as const,
  );
}

export async function newUserPage(browser: Browser, userId: string, displayName?: string, opts: { reducedMotion?: 'reduce' | 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}) });
  const page = await ctx.newPage();
  await signInFast(page, userId, displayName);
  return page;
}

export async function addTrack(page: Page, query: string) {
  await page.getByRole('tab', { name: 'My set' }).click();
  await page.getByTestId('set-search').fill(query);
  await page
    .getByRole('button', { name: `Add ${query}` })
    .first()
    .click();
  await expect(page.getByTestId('my-set')).toContainText(query);
  await expect(page.getByRole('status', { name: `${query} added to your set` }).first()).toBeVisible();
}

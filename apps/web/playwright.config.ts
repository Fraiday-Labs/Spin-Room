import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const API_PORT = 8081;
const WEB_PORT = 5174;
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
// Use the container's preinstalled Chromium when the bundled one isn't downloaded.
// E2E_SPLIT_ORIGIN=1 mimics split hosting (static web + API elsewhere): REST goes through the
// proxy, the live socket goes straight to the API on another site (localhost ≠ 127.0.0.1), so
// it can't use the session cookie and must use a one-time ticket.
const LIVE_ORIGIN = process.env.E2E_SPLIT_ORIGIN ? `ws://localhost:${API_PORT}` : '';
// E2E_SERVER=all runs the all-in-one server (API + MCP + Slack in one process) instead of the API.
const SERVER_DIR = process.env.E2E_SERVER === 'all' ? '../server' : '../api';
const SYSTEM_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: existsSync(SYSTEM_CHROME) && !process.env.PW_BUNDLED ? { executablePath: SYSTEM_CHROME } : {},
  },
  webServer: [
    {
      command: 'npx tsx src/main.ts',
      cwd: SERVER_DIR,
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        NODE_ENV: 'development',
        SPOTIFY_MODE: 'fake',
        AVATAR_SAFETY: 'auto_approve',
        ADMIN_SPOTIFY_IDS: 'e2e-site-admin',
        PUBLIC_ORIGIN: ORIGIN,
        DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://spinroom:spinroom@localhost:5432/spinroom_e2e',
        REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/14',
        STORAGE_DIR: '.data/e2e-blobs',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `npx vite --port ${WEB_PORT}`,
      url: ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { SPINROOM_API_URL: `http://127.0.0.1:${API_PORT}`, VITE_LIVE_ORIGIN: LIVE_ORIGIN },
    },
  ],
});

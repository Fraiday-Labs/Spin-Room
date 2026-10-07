import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/contracts',
      'packages/room-engine',
      'packages/sdk',
      'apps/api',
      'apps/mcp',
      'apps/slack',
      { extends: './apps/web/vite.config.ts', test: { name: 'web', root: './apps/web', include: ['src/**/*.test.{ts,tsx}'], environment: 'node' } },
    ],
  },
});

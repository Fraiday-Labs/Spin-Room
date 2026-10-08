import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/contracts', 'packages/room-engine', 'packages/sdk', 'apps/api', 'apps/mcp', 'apps/slack', 'apps/server', 'apps/web'],
  },
});

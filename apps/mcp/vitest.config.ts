import { defineProject } from 'vitest/config';
export default defineProject({
  test: {
    name: 'mcp',
    include: ['test/**/*.test.ts'],
    setupFiles: ['../api/test/setup.ts'],
    // Own database and Redis DB so suites can run in parallel with the API's.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL_MCP ?? 'postgres://spinroom:spinroom@localhost:5432/spinroom_test_mcp',
      REDIS_URL: process.env.TEST_REDIS_URL_MCP ?? 'redis://localhost:6379/13',
      STORAGE_DIR: '.data/test-blobs-mcp',
    },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

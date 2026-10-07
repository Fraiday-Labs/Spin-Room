import { defineProject } from 'vitest/config';
export default defineProject({
  test: {
    name: 'slack',
    include: ['test/**/*.test.ts'],
    setupFiles: ['../api/test/setup.ts'],
    // Own database and Redis DB so suites can run in parallel with the API's.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL_SLACK ?? 'postgres://spinroom:spinroom@localhost:5432/spinroom_test_slack',
      REDIS_URL: process.env.TEST_REDIS_URL_SLACK ?? 'redis://localhost:6379/12',
      STORAGE_DIR: '.data/test-blobs-slack',
    },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

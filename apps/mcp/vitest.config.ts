import { defineProject } from 'vitest/config';
export default defineProject({
  test: { name: 'mcp', include: ['test/**/*.test.ts'], setupFiles: ['../api/test/setup.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 },
});

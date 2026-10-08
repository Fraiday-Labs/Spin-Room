import { defineConfig } from 'tsup';
// The API, MCP and Slack sources are pulled in by relative import and bundled; their
// third-party dependencies stay external (listed in package.json).
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@spinroom\//],
});

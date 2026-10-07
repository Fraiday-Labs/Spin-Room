import { defineConfig } from 'tsup';
// Workspace packages are bundled so `npx spinroom-mcp` installs with only public deps.
export default defineConfig({
  entry: ['src/stdio.ts', 'src/http.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^@spinroom\//],
});

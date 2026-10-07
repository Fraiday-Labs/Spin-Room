// Fails when the initial JavaScript (entry + modulepreloads) exceeds 300 KB gzipped (PRD budget,
// Spotify SDK excluded — it loads from sdk.scdn.co only when a speaker starts).
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const files = new Set([...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]));
let total = 0;
for (const f of files) {
  const gz = gzipSync(readFileSync(join(dist, f)), { level: 9 }).length;
  total += gz;
  console.log(`${(gz / 1024).toFixed(1).padStart(7)} KB  ${f}`);
}
const css = [...html.matchAll(/href="\/(assets\/[^"]+\.css)"/g)].map((m) => m[1]);
const cssKb = css.reduce((n, f) => n + gzipSync(readFileSync(join(dist, f))).length, 0) / 1024;
console.log(`initial JS: ${(total / 1024).toFixed(1)} KB gzipped (budget 300 KB); CSS ${cssKb.toFixed(1)} KB`);
if (total > 300 * 1024) {
  console.error('Initial JS bundle is over budget');
  process.exit(1);
}

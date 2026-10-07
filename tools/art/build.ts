import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Canvas, hex } from './canvas.js';
import { CELL_H, CELL_W, CROWD, CROWD_H, CROWD_W, PRESETS, crowdAtlas, presetSheet } from './characters.js';
import { BOOTH, FLOOR_Y, MARQUEE, P, SLOT_X, SPOT_X, back, beam, booth, floor, laptop, ledStrip, pixelText, speakers } from './plates.js';

/** Builds every original Spinroom art asset into apps/web/public/art. */
const OUT = fileURLToPath(new URL('../../apps/web/public/art/', import.meta.url));
const BUDGET = 400 * 1024;

async function write(name: string, data: Buffer) {
  const p = join(OUT, name);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, data);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const plates = { back: back(), speakers: speakers(), booth: booth(), floor: floor() };
  for (const [k, c] of Object.entries(plates)) await write(`${k}.webp`, await c.webp());
  for (const [k, col] of Object.entries({ cyan: P.cyan, magenta: P.magenta, amber: P.amber, violet: P.violet }))
    await write(`beam-${k}.webp`, await beam(col).webp());
  await write('led.webp', await ledStrip().webp());
  await write('laptop.webp', await laptop().webp());

  // Preset avatars: native 24×26 cells → ×4 = 96×104 runtime cells (same format as imported pets).
  const sheets = new Map<string, Canvas>();
  for (const s of PRESETS) {
    const sheet = presetSheet(s);
    sheets.set(s.id, sheet);
    await write(`avatars/${s.id}.webp`, await sheet.scale(4).webp());
    const thumb = new Canvas(128, 128);
    const big = new Canvas(CELL_W, CELL_H);
    big.blit(sheet, 0, 0, { sw: CELL_W, sh: CELL_H });
    thumb.blit(big.scale(4), 16, 12);
    await write(`avatars/${s.id}-thumb.png`, await thumb.png());
  }

  const { base, mask } = crowdAtlas();
  await write('crowd.png', await base.png());
  await write('crowd-mask.png', await mask.png());

  // Favicon: the Spinroom record mark.
  const fav = new Canvas(16, 16);
  fav.disc(8, 8, 7, P.violet);
  fav.disc(8, 8, 6, P.indigo);
  fav.disc(8, 8, 2, P.magenta);
  fav.set(8, 8, P.cyan);
  fav.rect(11, 3, 2, 1, P.amber);
  await write('favicon.png', await fav.scale(2).png());

  // Stage preview for the landing page (static composite of the live layers).
  const st = new Canvas(480, 270);
  st.blit(plates.back, 0, 0);
  const beams = [P.violet, P.cyan, P.magenta, P.amber, P.violet];
  SPOT_X.forEach((x, i) => st.blit(beam(beams[i]!), x - 36, 30));
  st.blit(plates.speakers, 0, 0);
  const led = ledStrip();
  st.blit(led, 6 + 66, 78);
  st.blit(led, 480 - 6 - 72 + 66, 78);
  // equalizer bars
  const rainbow = [P.magenta, P.pink, P.amber, P.yellow, '#7CF2B0', P.cyan, P.violet, P.purple];
  for (let i = 0; i < 24; i++) {
    const h = 10 + Math.round(Math.abs(Math.sin(i * 1.7)) * 34);
    st.rect(132 + i * 9, 140 - h, 6, h, rainbow[i % rainbow.length]!, 150);
  }
  ['bolt', 'juno', 'tako'].forEach((id, i) => {
    const sheet = sheets.get(id)!;
    const dj = new Canvas(CELL_W, CELL_H);
    dj.blit(sheet, 0, 0, { sx: 0, sy: 3 * CELL_H, sw: CELL_W, sh: CELL_H });
    st.blit(dj.scale(2), SLOT_X[i]! - CELL_W, BOOTH.y - 46);
    pixelText(st, ['BOLT', 'JUNO', 'TAKO'][i]!, SLOT_X[i]! - 8, BOOTH.y - 54, [P.cyan, P.magenta, P.amber][i]!);
  });
  st.blit(plates.booth, 0, 0);
  const lap = laptop();
  for (const x of SLOT_X) st.blit(lap, x - 12, BOOTH.y - 16);
  pixelText(st, 'NEON TIDE - THE VELVET PIXELS', MARQUEE.x + 6, MARQUEE.y + 6, P.amber, 1);
  pixelText(st, '1:42', MARQUEE.x + 4, MARQUEE.y + 22, P.yellow);
  pixelText(st, '-2:16', MARQUEE.x + MARQUEE.w - 22, MARQUEE.y + 22, P.yellow);
  st.blit(plates.floor, 0, FLOOR_Y);
  const tints = [P.cyan, P.magenta, P.amber, P.purple, P.pink, P.yellow, P.violet, '#7CF2B0'];
  for (let i = 0; i < 26; i++) {
    const v = i % CROWD.length;
    const frame = i % 5 === 0 ? 2 : i % 7 === 0 ? 4 : i % 2;
    const fx = 20 + ((i * 37) % 440);
    const fy = 222 + (i % 3) * 14;
    const fig = new Canvas(CROWD_W, CROWD_H);
    fig.blit(base, 0, 0, { sx: frame * CROWD_W, sy: v * CROWD_H, sw: CROWD_W, sh: CROWD_H });
    const m = new Canvas(CROWD_W, CROWD_H);
    m.blit(mask, 0, 0, { sx: frame * CROWD_W, sy: v * CROWD_H, sw: CROWD_W, sh: CROWD_H });
    const tint = hex(tints[i % tints.length]!);
    for (let p = 0; p < m.data.length; p += 4) if (m.data[p + 3]) fig.data.set(tint, p);
    st.blit(fig.scale(2), fx, fy);
  }
  await write('stage-preview.webp', await st.scale(2).webp());

  // Budget check (PRD: plates and built-in sprites under 400 KB total).
  let total = 0;
  const walk = async (dir: string) => {
    for (const f of await readdir(dir)) {
      const p = join(dir, f);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else if (!f.startsWith('stage-preview')) total += s.size;
    }
  };
  await walk(OUT);
  console.log(`art: ${(total / 1024).toFixed(1)} KB (budget ${BUDGET / 1024} KB)`);
  if (total > BUDGET) throw new Error('art over budget');
}

await main();

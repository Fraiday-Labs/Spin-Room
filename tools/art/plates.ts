import { Canvas, hex, rng } from './canvas.js';

/** Pixel Neon DJ palette (docs/design/pixel-neon-dj.md) plus a few shades. */
export const P = {
  night: '#0B1026',
  indigo: '#1A1440',
  violet: '#5B2DFF',
  magenta: '#FF2BD6',
  pink: '#FF4FA3',
  cyan: '#3DE2FF',
  purple: '#7A4DFF',
  amber: '#FFB000',
  yellow: '#FFD24A',
  booth: '#2A3142',
  charcoal: '#1C2230',
  // shades
  brick: '#231A52',
  brick2: '#1E1748',
  brickHi: '#2C2263',
  mortar: '#120D30',
  metal: '#3A4560',
  metalHi: '#56627F',
  metalLo: '#1A2030',
  black: '#06070F',
  white: '#F2F0FF',
} as const;

export const W = 480;
export const H = 270;
export const FLOOR_Y = 214;
export const SPOT_X = [48, 144, 240, 336, 432] as const;
export const BOOTH = { x: 128, y: 148, w: 224, h: 66 } as const;
export const MARQUEE = { x: 150, y: 168, w: 180, h: 30 } as const;
export const SLOT_X = [176, 240, 304] as const;

/** Back wall (brick), lighting truss and the five spotlight cans. */
export function back(): Canvas {
  const c = new Canvas(W, H);
  const r = rng(11);
  c.rect(0, 0, W, H, P.night);
  // Bricks: 16×6 running bond.
  for (let row = 0; row * 7 < FLOOR_Y; row++) {
    const y = row * 7;
    const off = row % 2 ? 8 : 0;
    for (let x = -off; x < W; x += 17) {
      const shade = r() < 0.15 ? P.brickHi : r() < 0.5 ? P.brick : P.brick2;
      c.rect(x, y, 16, 6, shade);
      // speckles
      for (let k = 0; k < 3; k++) c.set(x + Math.floor(r() * 16), y + Math.floor(r() * 6), P.mortar);
    }
  }
  // Darken the top band with dither so the truss reads (no gradients).
  c.dither(0, 0, W, 10, P.night, P.mortar, 0.25);
  // Floor shadow line.
  c.rect(0, FLOOR_Y - 2, W, 2, P.mortar);

  // Neon record sign on the wall (Spinroom mark).
  const sx = 240;
  const sy = 50;
  c.disc(sx, sy, 15, P.night);
  c.ring(sx, sy, 15, P.magenta);
  c.ring(sx, sy, 14, '#B21F96');
  c.ring(sx, sy, 9, P.purple);
  c.disc(sx, sy, 3, P.cyan);
  c.rect(sx + 8, sy - 13, 6, 2, P.amber);
  // Glow halo (stepped alpha).
  for (let rr = 17; rr <= 20; rr++) c.ring(sx, sy, rr, hex(P.magenta, 60 - (rr - 17) * 14));

  // Truss: two rails with a zigzag lattice.
  const top = 4;
  const bot = 16;
  c.rect(0, top, W, 3, P.metal);
  c.rect(0, bot, W, 3, P.metal);
  c.hline(0, W, top, P.metalHi);
  c.hline(0, W, bot, P.metalHi);
  for (let x = 0; x < W; x += 12) {
    c.line(x, top + 3, x + 6, bot - 1, P.metalLo);
    c.line(x + 6, bot - 1, x + 12, top + 3, P.metalLo);
    c.line(x + 1, top + 3, x + 7, bot - 1, P.metal);
    c.line(x + 7, bot - 1, x + 13, top + 3, P.metal);
  }
  // Spotlight cans.
  for (const x of SPOT_X) {
    c.rect(x - 1, bot + 3, 3, 3, P.metalLo);
    c.rect(x - 6, bot + 6, 12, 9, P.charcoal);
    c.rect(x - 6, bot + 6, 12, 1, P.metal);
    c.rect(x - 5, bot + 14, 10, 2, P.yellow);
    c.rect(x - 4, bot + 15, 8, 1, '#FFF4C2');
  }
  return c;
}

/** A spotlight beam sprite (translucent, stepped alpha) in one neon color. */
export function beam(color: string): Canvas {
  const w = 72;
  const h = 200;
  const c = new Canvas(w, h);
  for (let y = 0; y < h; y++) {
    const half = 4 + Math.floor((y / h) * (w / 2 - 4));
    const band = y < 40 ? 70 : y < 90 ? 54 : y < 150 ? 40 : 28;
    for (let x = w / 2 - half; x < w / 2 + half; x++) {
      const edge = Math.min(x - (w / 2 - half), w / 2 + half - 1 - x);
      const a = edge < 2 ? band / 2 : band;
      // Checker dither on the outer edge keeps it crisp.
      if (edge < 2 && (x + y) % 2) continue;
      c.set(x, y, color, a);
    }
  }
  return c;
}

/** Left and right speaker stacks. */
export function speakers(): Canvas {
  const c = new Canvas(W, H);
  const stack = (x: number) => {
    const y0 = 74;
    // cabinets
    for (const [cy, ch, woofer] of [
      [y0, 46, 13],
      [y0 + 48, 46, 13],
      [y0 + 96, 44, 12],
    ] as const) {
      c.rect(x, cy, 72, ch, P.charcoal);
      c.frame(x, cy, 72, ch, P.metalLo);
      c.hline(x + 1, x + 70, cy + 1, P.metal);
      c.disc(x + 26, cy + ch / 2, woofer, P.black);
      c.ring(x + 26, cy + ch / 2, woofer, P.metal);
      c.ring(x + 26, cy + ch / 2, woofer - 4, P.metalLo);
      c.disc(x + 26, cy + ch / 2, 3, P.metal);
      c.disc(x + 56, cy + 12, 5, P.black);
      c.ring(x + 56, cy + 12, 5, P.metal);
      c.rect(x + 50, cy + 24, 12, 14, P.black);
      for (let k = 0; k < 4; k++) c.hline(x + 51, x + 60, cy + 26 + k * 3, P.metalLo);
    }
    // LED strip housings (the lit LEDs are a separate animated layer).
    c.rect(x + 66, y0 + 4, 3, 132, P.black);
  };
  stack(6);
  stack(W - 6 - 72);
  return c;
}

/** Vertical LED strip segment (animated in CSS by opacity steps). */
export function ledStrip(): Canvas {
  const c = new Canvas(3, 132);
  const colors = [P.magenta, P.pink, P.purple, P.violet, P.cyan];
  for (let y = 0; y < 132; y += 4) {
    const col = colors[Math.floor(y / 4) % colors.length]!;
    c.rect(0, y, 3, 3, col);
    c.set(1, y + 1, P.white);
  }
  return c;
}

/** DJ booth body with grills and the black LED marquee recess. */
export function booth(): Canvas {
  const c = new Canvas(W, H);
  const { x, y, w, h } = BOOTH;
  // shadow on floor
  c.dither(x - 6, y + h, w + 12, 4, P.night, P.black, 0.5);
  c.rect(x, y, w, h, P.booth);
  c.rect(x - 4, y - 4, w + 8, 6, P.metal); // tabletop
  c.hline(x - 4, x + w + 3, y - 4, P.metalHi);
  c.hline(x - 4, x + w + 3, y + 1, P.metalLo);
  c.frame(x, y, w, h, P.metalLo);
  // side grills
  for (const gx of [x + 6, x + w - 18]) {
    c.rect(gx, y + 14, 12, 40, P.black);
    for (let k = 0; k < 10; k++) c.hline(gx + 1, gx + 10, y + 16 + k * 4, P.metalLo);
  }
  // marquee recess
  const m = MARQUEE;
  c.rect(m.x - 3, m.y - 3, m.w + 6, m.h + 6, P.metalLo);
  c.rect(m.x - 2, m.y - 2, m.w + 4, m.h + 4, P.metal);
  c.rect(m.x, m.y, m.w, m.h, P.black);
  // unlit LED dot grid
  for (let yy = m.y + 1; yy < m.y + m.h; yy += 2) for (let xx = m.x + 1; xx < m.x + m.w; xx += 2) c.set(xx, yy, '#1A1208');
  // neon trim along the bottom
  c.hline(x + 2, x + w - 3, y + h - 4, P.violet);
  c.hline(x + 2, x + w - 3, y + h - 3, '#3A1FA8');
  return c;
}

/** Laptop seen from the crowd (back of the lid) with the original Spinroom mark. */
export function laptop(): Canvas {
  const c = new Canvas(24, 15);
  c.rect(1, 0, 22, 13, '#C9CEDA');
  c.frame(1, 0, 22, 13, '#8A92A6');
  c.rect(0, 13, 24, 2, '#8A92A6');
  // Spinroom mark: a tiny record with a neon spindle.
  c.disc(12, 6, 4, P.indigo);
  c.ring(12, 6, 4, P.violet);
  c.set(12, 6, P.magenta);
  c.set(15, 3, P.amber);
  return c;
}

/** Reflective dance floor. */
export function floor(): Canvas {
  const c = new Canvas(W, H - FLOOR_Y);
  const fh = H - FLOOR_Y;
  c.rect(0, 0, W, fh, P.charcoal);
  // tiles with perspective-ish lines toward the booth center
  for (let y = 4; y < fh; y += 8) c.hline(0, W - 1, y, '#151A26');
  for (let k = -12; k <= 12; k++) {
    const x0 = 240 + k * 20;
    const x1 = 240 + k * 42;
    c.line(x0, 0, x1, fh - 1, '#151A26');
  }
  // reflections of spotlights and the booth trim (dithered streaks)
  for (const [x, col] of [
    [48, P.violet],
    [144, P.cyan],
    [240, P.magenta],
    [336, P.amber],
    [432, P.violet],
  ] as const) {
    for (let y = 2; y < fh; y += 2) {
      const half = 3 + Math.floor(y / 6);
      for (let xx = x - half; xx <= x + half; xx += 2) if ((xx + y) % 4 === 0) c.set(xx, y, col, 70);
    }
  }
  c.hline(BOOTH.x, BOOTH.x + BOOTH.w, 1, P.violet, 120);
  return c;
}

/** Tiny 3×5 pixel font for the marquee in the static preview image. */
const FONT: Record<string, string> = {
  A: '010101111101101',
  B: '110101110101110',
  C: '011100100100011',
  D: '110101101101110',
  E: '111100110100111',
  F: '111100110100100',
  G: '011100101101011',
  H: '101101111101101',
  I: '111010010010111',
  J: '001001001101010',
  K: '101101110101101',
  L: '100100100100111',
  M: '101111111101101',
  N: '110101101101101',
  O: '010101101101010',
  P: '110101110100100',
  Q: '010101101110011',
  R: '110101110101101',
  S: '011100010001110',
  T: '111010010010010',
  U: '101101101101111',
  V: '101101101101010',
  W: '101101111111101',
  X: '101101010101101',
  Y: '101101010010010',
  Z: '111001010100111',
  ' ': '000000000000000',
  '-': '000000111000000',
  ':': '000010000010000',
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '110001010100111',
  '3': '110001010001110',
  '4': '101101111001001',
  '5': '111100110001110',
};

export function pixelText(c: Canvas, text: string, x: number, y: number, color: string, scale = 1) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] ?? FONT[' ']!;
    for (let i = 0; i < 15; i++) if (g[i] === '1') c.rect(cx + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale, color);
    cx += 4 * scale;
  }
}

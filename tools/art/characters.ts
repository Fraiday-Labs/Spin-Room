import { Canvas } from './canvas.js';
import { P } from './plates.js';

/**
 * Original Spinroom characters, drawn in code. Front-facing presets are 24×26 cells
 * (upscaled ×4 to the 96×104 runtime cell shared with imported pets). Crowd figures are
 * 16×20 back views with a separate tint mask for each member's color.
 */

export const CELL_W = 24;
export const CELL_H = 26;

export type PresetState = 'idle' | 'hype' | 'skip' | 'dj' | 'walk' | 'wave' | 'away';
export const PRESET_ROWS: { state: PresetState; frames: number }[] = [
  { state: 'idle', frames: 4 },
  { state: 'hype', frames: 4 },
  { state: 'skip', frames: 4 },
  { state: 'dj', frames: 4 },
  { state: 'walk', frames: 4 },
  { state: 'wave', frames: 4 },
  { state: 'away', frames: 2 },
];

interface Spec {
  id: string;
  outline: string;
  head: string;
  headHi: string;
  body: string;
  bodyHi: string;
  accent: string;
  eye: string;
  kind: 'robot' | 'dumpling' | 'kid' | 'buns' | 'octo' | 'hood';
  skin?: string;
}

export const PRESETS: Spec[] = [
  { id: 'bolt', kind: 'robot', outline: '#0E1222', head: '#8C97B3', headHi: '#C4CCE0', body: '#5D6A88', bodyHi: '#8C97B3', accent: P.cyan, eye: P.cyan },
  {
    id: 'mochi',
    kind: 'dumpling',
    outline: '#3A2240',
    head: '#FFE6EF',
    headHi: '#FFFFFF',
    body: '#FFC7DA',
    bodyHi: '#FFE6EF',
    accent: '#5BD17A',
    eye: '#2A1830',
  },
  {
    id: 'pix',
    kind: 'kid',
    outline: '#1A0F24',
    head: '#F2C29B',
    headHi: '#FFD9B8',
    body: P.violet,
    bodyHi: P.purple,
    accent: P.magenta,
    eye: '#1A0F24',
    skin: '#F2C29B',
  },
  {
    id: 'juno',
    kind: 'buns',
    outline: '#1A0F24',
    head: '#B9784F',
    headHi: '#D08F63',
    body: P.amber,
    bodyHi: P.yellow,
    accent: '#2B1A10',
    eye: '#1A0F24',
    skin: '#B9784F',
  },
  { id: 'tako', kind: 'octo', outline: '#24103A', head: '#A267FF', headHi: '#C29BFF', body: '#8A4DF0', bodyHi: '#A267FF', accent: P.pink, eye: '#FFFFFF' },
  {
    id: 'rue',
    kind: 'hood',
    outline: '#071A22',
    head: '#2FB9D8',
    headHi: P.cyan,
    body: '#2391AE',
    bodyHi: '#2FB9D8',
    accent: P.yellow,
    eye: '#071A22',
    skin: '#1B2433',
  },
];

interface Pose {
  dy: number;
  dx: number;
  armL: 'down' | 'up' | 'out' | 'deck' | 'wave1' | 'wave2' | 'cross';
  armR: 'down' | 'up' | 'out' | 'deck' | 'wave1' | 'wave2' | 'cross';
  legs: 'stand' | 'stepL' | 'stepR' | 'hop';
  face: 'happy' | 'neutral' | 'frown' | 'blink' | 'sleep' | 'grin';
}

function pose(state: PresetState, f: number): Pose {
  switch (state) {
    case 'idle':
      return { dy: [0, 0, 1, 1][f]!, dx: 0, armL: 'down', armR: 'down', legs: 'stand', face: f === 3 ? 'blink' : 'neutral' };
    case 'hype':
      return { dy: [0, -2, -3, -1][f]!, dx: 0, armL: f % 2 ? 'up' : 'out', armR: f % 2 ? 'out' : 'up', legs: f === 2 ? 'hop' : 'stand', face: 'grin' };
    case 'skip':
      return { dy: 1, dx: [-1, 0, 1, 0][f]!, armL: 'cross', armR: 'cross', legs: 'stand', face: 'frown' };
    case 'dj':
      return { dy: [0, 1, 0, 1][f]!, dx: 0, armL: 'deck', armR: f === 2 ? 'up' : 'deck', legs: 'stand', face: 'happy' };
    case 'walk':
      return { dy: [0, -1, 0, -1][f]!, dx: 0, armL: f % 2 ? 'out' : 'down', armR: f % 2 ? 'down' : 'out', legs: f % 2 ? 'stepR' : 'stepL', face: 'neutral' };
    case 'wave':
      return { dy: 0, dx: 0, armL: 'down', armR: f % 2 ? 'wave2' : 'wave1', legs: 'stand', face: 'happy' };
    case 'away':
      return { dy: 1, dx: 0, armL: 'down', armR: 'down', legs: 'stand', face: 'sleep' };
  }
}

/** Draw one preset frame into a 24×26 cell at (ox, oy). */
function drawPreset(c: Canvas, s: Spec, state: PresetState, f: number, ox: number, oy: number) {
  const p = pose(state, f);
  const X = ox + p.dx;
  const Y = oy + p.dy;
  const o = s.outline;

  // Legs
  const legY = Y + 21;
  const legColor = s.kind === 'octo' ? s.body : s.kind === 'robot' ? s.bodyHi : '#2A2F45';
  const leg = (lx: number, ly: number, len: number) => {
    c.rect(lx, ly, 3, len, legColor);
    c.rect(lx, ly + len, 4, 1, o);
  };
  if (s.kind === 'octo') {
    for (let k = 0; k < 4; k++) {
      const lx = X + 7 + k * 3;
      const wig = (k + f) % 2;
      c.rect(lx, legY - 1, 2, 4, s.body);
      c.set(lx + (wig ? 1 : -1) + 1, legY + 3, s.body);
      c.set(lx, legY + 3, o);
    }
  } else if (p.legs === 'stand' || p.legs === 'hop') {
    leg(X + 8, legY, p.legs === 'hop' ? 2 : 3);
    leg(X + 13, legY, p.legs === 'hop' ? 2 : 3);
  } else {
    leg(X + (p.legs === 'stepL' ? 7 : 8), legY, p.legs === 'stepL' ? 3 : 2);
    leg(X + (p.legs === 'stepR' ? 14 : 13), legY, p.legs === 'stepR' ? 3 : 2);
  }

  // Body
  const bx = X + 6;
  const by = Y + 14;
  c.rect(bx, by, 12, 8, s.body);
  c.rect(bx + 1, by, 10, 1, s.bodyHi);
  c.frame(bx - 1, by - 1, 14, 10, o);
  c.rect(bx, by, 12, 8, s.body);
  c.hline(bx + 1, bx + 10, by, s.bodyHi);
  if (s.kind === 'robot') {
    c.rect(bx + 4, by + 2, 4, 3, P.night);
    c.set(bx + 5, by + 3, s.accent);
    c.set(bx + 6, by + 3, P.magenta);
  } else if (s.kind === 'kid' || s.kind === 'hood') {
    c.vline(bx + 6, by + 1, by + 7, s.bodyHi);
    c.rect(bx + 3, by + 5, 6, 2, s.bodyHi);
  } else if (s.kind === 'buns') {
    c.rect(bx + 5, by + 1, 2, 7, '#E89A00');
  }

  // Arms (2 px wide), hands are skin/head color
  const hand = s.skin ?? s.head;
  const arm = (side: -1 | 1, kind: Pose['armL']) => {
    const sx = side < 0 ? bx - 3 : bx + 12;
    switch (kind) {
      case 'down':
        c.rect(sx, by + 1, 2, 6, s.body);
        c.rect(sx, by + 7, 2, 2, hand);
        break;
      case 'out':
        c.rect(side < 0 ? sx - 2 : sx, by + 1, 4, 2, s.body);
        c.rect(side < 0 ? sx - 3 : sx + 3, by, 2, 2, hand);
        break;
      case 'up':
        c.rect(sx, by - 6, 2, 7, s.body);
        c.rect(sx, by - 8, 2, 2, hand);
        break;
      case 'deck':
        c.rect(sx, by + 2, 2, 4, s.body);
        c.rect(side < 0 ? sx + 1 : sx - 1, by + 6, 2, 2, hand);
        break;
      case 'wave1':
        c.rect(sx, by - 5, 2, 6, s.body);
        c.rect(sx + 1, by - 7, 2, 2, hand);
        break;
      case 'wave2':
        c.rect(sx + 1, by - 5, 2, 6, s.body);
        c.rect(sx + 2, by - 7, 2, 2, hand);
        break;
      case 'cross':
        c.rect(bx + 1, by + 3, 10, 2, s.bodyHi);
        c.rect(side < 0 ? bx + 1 : bx + 9, by + 3, 2, 2, hand);
        break;
    }
  };
  arm(-1, p.armL);
  arm(1, p.armR);

  // Head (14×12) with per-character features
  const hx = X + 5;
  const hy = Y + 2;
  const head = () => {
    c.rect(hx, hy, 14, 12, s.head);
    c.frame(hx - 1, hy - 1, 16, 14, o);
    c.rect(hx, hy, 14, 12, s.head);
    c.hline(hx + 1, hx + 12, hy, s.headHi);
  };
  switch (s.kind) {
    case 'robot':
      head();
      c.rect(hx + 2, hy + 3, 10, 5, P.night); // visor
      c.vline(hx + 7, hy - 4, hy - 2, s.bodyHi);
      c.set(hx + 7, hy - 5, P.magenta);
      c.rect(hx - 2, hy + 4, 1, 3, s.bodyHi);
      c.rect(hx + 15, hy + 4, 1, 3, s.bodyHi);
      break;
    case 'dumpling':
      c.disc(hx + 7, hy + 7, 7, o);
      c.disc(hx + 7, hy + 7, 6, s.head);
      c.hline(hx + 4, hx + 9, hy + 2, s.headHi);
      c.rect(hx + 6, hy - 1, 2, 2, s.accent); // leaf sprout
      c.set(hx + 8, hy - 2, s.accent);
      c.set(hx + 3, hy + 9, '#FF9EC0');
      c.set(hx + 11, hy + 9, '#FF9EC0');
      break;
    case 'kid':
      head();
      c.rect(hx, hy, 14, 4, '#3A2418'); // hair
      c.rect(hx - 2, hy + 4, 3, 5, s.accent); // headphones
      c.rect(hx + 13, hy + 4, 3, 5, s.accent);
      c.hline(hx, hx + 13, hy - 2, s.accent);
      break;
    case 'buns':
      head();
      c.rect(hx, hy, 14, 3, s.accent);
      c.disc(hx - 1, hy + 1, 3, s.accent);
      c.disc(hx + 14, hy + 1, 3, s.accent);
      c.set(hx + 3, hy + 9, '#E07A6A');
      c.set(hx + 10, hy + 9, '#E07A6A');
      break;
    case 'octo':
      c.disc(hx + 7, hy + 6, 7, o);
      c.disc(hx + 7, hy + 6, 6, s.head);
      c.hline(hx + 4, hx + 9, hy + 1, s.headHi);
      c.rect(hx + 2, hy - 2, 10, 3, s.accent); // beanie
      c.hline(hx + 2, hx + 11, hy + 1, '#C2306E');
      c.set(hx + 7, hy - 3, '#FFFFFF');
      break;
    case 'hood':
      c.disc(hx + 7, hy + 6, 8, o);
      c.disc(hx + 7, hy + 6, 7, s.head);
      c.rect(hx + 1, hy - 3, 3, 3, s.head); // hood points
      c.rect(hx + 10, hy - 3, 3, 3, s.head);
      c.rect(hx + 3, hy + 3, 8, 7, s.skin!); // face opening
      break;
  }

  // Face
  const ex = hx + (s.kind === 'robot' ? 4 : 4);
  const ey = hy + (s.kind === 'robot' ? 5 : s.kind === 'hood' ? 5 : 5);
  const eyeColor = s.kind === 'hood' ? s.accent : s.eye;
  if (p.face === 'blink' || p.face === 'sleep') {
    c.hline(ex, ex + 1, ey + 1, eyeColor);
    c.hline(ex + 5, ex + 6, ey + 1, eyeColor);
    if (p.face === 'sleep') {
      c.set(hx + 15, hy - 1, P.white);
      c.set(hx + 16, hy - 1, P.white);
      c.set(hx + 15, hy - 2, P.white);
      c.set(hx + 16, hy - 3, P.white);
      c.set(hx + 15, hy - 3, P.white);
    }
  } else {
    c.rect(ex, ey, 2, 2, eyeColor);
    c.rect(ex + 5, ey, 2, 2, eyeColor);
    if (s.kind !== 'robot') {
      c.set(ex, ey, '#FFFFFF');
      c.set(ex + 5, ey, '#FFFFFF');
    }
  }
  const my = ey + 4;
  const mouth = s.kind === 'robot' ? s.accent : s.outline;
  if (p.face === 'grin') {
    c.hline(ex + 1, ex + 5, my, mouth);
    c.hline(ex + 2, ex + 4, my + 1, mouth);
  } else if (p.face === 'happy') {
    c.set(ex + 1, my, mouth);
    c.hline(ex + 2, ex + 4, my + 1, mouth);
    c.set(ex + 5, my, mouth);
  } else if (p.face === 'frown') {
    c.set(ex + 1, my + 1, mouth);
    c.hline(ex + 2, ex + 4, my, mouth);
    c.set(ex + 5, my + 1, mouth);
  } else if (p.face !== 'sleep') {
    c.hline(ex + 2, ex + 4, my, mouth);
  }
}

/** A preset's runtime sheet (rows = PRESET_ROWS) at native 24×26 cells. */
export function presetSheet(s: Spec): Canvas {
  const cols = Math.max(...PRESET_ROWS.map((r) => r.frames));
  const c = new Canvas(cols * CELL_W, PRESET_ROWS.length * CELL_H);
  PRESET_ROWS.forEach((row, r) => {
    for (let f = 0; f < row.frames; f++) drawPreset(c, s, row.state, f, f * CELL_W, r * CELL_H);
  });
  return c;
}

// ------------------------------------------------------------------ crowd (back views)

export const CROWD_W = 16;
export const CROWD_H = 20;
/** Frames: idle0, idle1, hype0, hype1, skip (turned away). */
export const CROWD_FRAMES = 5;

interface CrowdSpec {
  id: string;
  hair: string;
  style: 'hoodie' | 'beanie' | 'pigtails' | 'robot' | 'mascot' | 'cap' | 'puff' | 'ponytail';
  skin: string;
}

export const CROWD: CrowdSpec[] = [
  { id: 'hoodie', hair: '#2B1A10', style: 'hoodie', skin: '#C98A5E' },
  { id: 'beanie', hair: '#5A3A22', style: 'beanie', skin: '#F2C29B' },
  { id: 'pigtails', hair: '#E8B04A', style: 'pigtails', skin: '#F2C29B' },
  { id: 'robot', hair: '#8C97B3', style: 'robot', skin: '#8C97B3' },
  { id: 'mascot', hair: '#FFFFFF', style: 'mascot', skin: '#FFFFFF' },
  { id: 'cap', hair: '#1A0F0A', style: 'cap', skin: '#7A4A2E' },
  { id: 'puff', hair: '#1A0F0A', style: 'puff', skin: '#8F5A3A' },
  { id: 'ponytail', hair: '#A0303A', style: 'ponytail', skin: '#F2C29B' },
];

/**
 * Draw a crowd frame. `base` gets hair/skin/outline; `mask` gets the clothing pixels
 * (white) that the web app tints with each member's color via CSS masks.
 */
function drawCrowd(base: Canvas, mask: Canvas, s: CrowdSpec, frame: number, ox: number, oy: number) {
  const o = '#0A0C18';
  const bob = frame === 1 || frame === 3 ? 1 : 0;
  const hype = frame === 2 || frame === 3;
  const skip = frame === 4;
  const Y = oy + bob + (hype ? -1 : 0);
  const X = ox + (skip ? 1 : 0);
  const cloth = (x: number, y: number, w: number, h: number) => {
    base.rect(x, y, w, h, '#000000', 0);
    mask.rect(x, y, w, h, '#FFFFFF');
  };
  // shoulders / torso (seen from behind)
  base.rect(X + 2, Y + 10, 12, 10, o);
  cloth(X + 3, Y + 11, 10, 9);
  // arms
  if (hype) {
    const up = frame === 2 ? [0, 0] : [1, -1];
    base.rect(X + 1, Y + 2 + up[0]!, 3, 9, o);
    base.rect(X + 12, Y + 2 + up[1]!, 3, 9, o);
    cloth(X + 2, Y + 4 + up[0]!, 1, 7);
    cloth(X + 13, Y + 4 + up[1]!, 1, 7);
    base.rect(X + 2, Y + 2 + up[0]!, 1, 2, s.skin);
    base.rect(X + 13, Y + 2 + up[1]!, 1, 2, s.skin);
  } else if (skip) {
    base.rect(X + 1, Y + 12, 2, 7, o);
    cloth(X + 1, Y + 13, 1, 5);
  } else {
    base.rect(X + 1, Y + 11, 2, 8, o);
    base.rect(X + 13, Y + 11, 2, 8, o);
    cloth(X + 1, Y + 12, 1, 6);
    cloth(X + 14, Y + 12, 1, 6);
  }
  // head (back of head = hair)
  const hx = X + 4;
  const hy = Y + 2;
  base.rect(hx - 1, hy - 1, 10, 10, o);
  base.rect(hx, hy, 8, 8, s.hair);
  if (skip) {
    // turned away: a sliver of face on the right
    base.rect(hx + 6, hy + 3, 2, 4, s.skin);
    base.set(hx + 7, hy + 4, o);
  } else {
    base.set(hx - 1, hy + 4, s.skin);
    base.set(hx + 8, hy + 4, s.skin);
  }
  switch (s.style) {
    case 'hoodie':
      cloth(hx - 1, hy + 1, 10, 7);
      base.rect(hx + 1, hy + 2, 6, 3, s.hair);
      break;
    case 'beanie':
      cloth(hx, hy - 1, 8, 4);
      base.set(hx + 4, hy - 2, '#FFFFFF');
      break;
    case 'pigtails':
      base.rect(hx - 3, hy + 3, 2, 5, s.hair);
      base.rect(hx + 9, hy + 3, 2, 5, s.hair);
      base.set(hx - 2, hy + 3, '#FF4FA3');
      base.set(hx + 9, hy + 3, '#FF4FA3');
      break;
    case 'robot':
      base.rect(hx, hy, 8, 8, '#8C97B3');
      base.rect(hx + 1, hy + 1, 6, 1, '#C4CCE0');
      base.vline(hx + 4, hy - 3, hy - 1, '#8C97B3');
      base.set(hx + 4, hy - 4, '#FF2BD6');
      break;
    case 'mascot':
      cloth(hx - 1, hy, 10, 8);
      cloth(hx - 1, hy - 3, 3, 3);
      cloth(hx + 6, hy - 3, 3, 3);
      break;
    case 'cap':
      cloth(hx, hy, 8, 3);
      cloth(hx + 1, hy + 3, 6, 1);
      break;
    case 'puff':
      base.disc(hx + 4, hy + 2, 5, s.hair);
      break;
    case 'ponytail':
      base.rect(hx + 3, hy + 7, 2, 5, s.hair);
      base.set(hx + 3, hy + 6, '#FFB000');
      break;
  }
}

/** Crowd atlas: rows = CROWD variants, cols = frames. Returns base and tint mask. */
export function crowdAtlas(): { base: Canvas; mask: Canvas } {
  const base = new Canvas(CROWD_FRAMES * CROWD_W, CROWD.length * CROWD_H);
  const mask = new Canvas(base.w, base.h);
  CROWD.forEach((s, r) => {
    for (let f = 0; f < CROWD_FRAMES; f++) drawCrowd(base, mask, s, f, f * CROWD_W, r * CROWD_H);
  });
  // Clothing pixels live only in the mask; clear them from the base.
  for (let i = 3; i < mask.data.length; i += 4) if (mask.data[i]) base.data[i] = 0;
  return { base, mask };
}

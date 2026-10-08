import { AVATAR_LIMITS, AVATAR_MAPPING, PET_FORMAT, poseKey, poseOf, RUNTIME_SHEET, type AvatarState, type AvatarValidationIssue } from '@spinroom/contracts';
import { unzipSync } from 'fflate';
import sharp, { type Metadata, type OverlayOptions } from 'sharp';

/**
 * ChatGPT / Codex pet import (FR-A1–A8). Pure functions over buffers: no storage, no DB.
 * The route stores results by content hash and runs the safety check.
 */

export class AvatarImportError extends Error {
  constructor(
    readonly issueCode: string,
    message: string,
    readonly extra: { needsGrid?: { cols: number; rows: number }; detectedSize?: { w: number; h: number } } = {},
  ) {
    super(message);
    this.name = 'AvatarImportError';
  }
}

export type FileKind = 'zip' | 'png' | 'webp' | 'json' | 'unknown';

/** FR-A2: detect type from bytes, never the extension. */
export function sniff(buf: Buffer): FileKind {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const head = buf.subarray(0, 64).toString('utf8').trimStart();
  if (head.startsWith('{')) return 'json';
  return 'unknown';
}

export interface PetMeta {
  name: string | null;
  spritesheet: string | null;
  version: 1 | 2 | null;
}

/** FR-A4: pet.json is untrusted — size-capped, only known fields, never rendered as HTML. */
export function parsePetJson(buf: Buffer): PetMeta {
  if (buf.length > AVATAR_LIMITS.petJsonMaxBytes)
    throw new AvatarImportError('pet_json_too_large', 'pet.json is larger than 64 KB — use the file from Download sprite kit.');
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new AvatarImportError('pet_json_invalid', 'pet.json isn’t valid JSON — re-download the sprite kit from ChatGPT.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AvatarImportError('pet_json_invalid', 'pet.json should be a JSON object.');
  const o = raw as Record<string, unknown>;
  const str = (...keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string;
    return null;
  };
  const name = str('name', 'displayName', 'display_name', 'title');
  const sheet = str('spritesheet', 'spriteSheet', 'sprite_sheet', 'spritesheetPath', 'image');
  const v = o.spriteVersionNumber ?? o.sprite_version_number ?? o.version;
  return {
    name: name ? sanitizeName(name) : null,
    spritesheet: sheet,
    version: v === 2 || v === '2' ? 2 : v === 1 || v === '1' ? 1 : null,
  };
}

// eslint-disable-next-line no-control-regex
const NAME_STRIP = /[\u0000-\u001F\u007F<>]/g;

/** Plain text only, 32 characters max. */
export function sanitizeName(s: string): string {
  return s.replace(NAME_STRIP, '').replace(/\s+/g, ' ').trim().slice(0, AVATAR_LIMITS.nameMaxLength);
}

const IGNORED = (name: string) => name.startsWith('__MACOSX/') || name.endsWith('.DS_Store') || name.endsWith('/');

/** FR-A1: read only pet.json and the sheet it names; reject anything else. */
export function readSpriteKit(zip: Buffer): { petJson: Buffer; sheet: Buffer; sheetName: string } {
  const entries: { name: string; size: number }[] = [];
  try {
    unzipSync(new Uint8Array(zip), {
      filter: (f) => {
        entries.push({ name: f.name, size: f.originalSize });
        return false;
      },
    });
  } catch {
    throw new AvatarImportError('zip_invalid', 'That zip file is damaged — download the sprite kit again.');
  }
  const files = entries.filter((e) => !IGNORED(e.name));
  for (const e of files) {
    if (e.name.includes('..') || e.name.startsWith('/') || e.name.includes('\\') || e.name.includes('/')) {
      throw new AvatarImportError('zip_nested', `The zip contains “${e.name}”. Sprite kits hold only pet.json and the sprite sheet at the top level.`);
    }
  }
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > AVATAR_LIMITS.zipExpandedMaxBytes)
    throw new AvatarImportError('zip_too_large', 'The zip expands past 20 MB. Sprite kits are much smaller — re-download it from ChatGPT.');
  if (!files.some((e) => e.name === 'pet.json'))
    throw new AvatarImportError('pet_json_missing', 'The zip has no pet.json. Use Download sprite kit in ChatGPT’s Pets settings.');

  const pick = (name: string) => {
    const out = unzipSync(new Uint8Array(zip), { filter: (f) => f.name === name });
    const data = out[name];
    if (!data) throw new AvatarImportError('zip_invalid', `Couldn’t read ${name} from the zip.`);
    if (data.length > AVATAR_LIMITS.zipExpandedMaxBytes) throw new AvatarImportError('zip_too_large', 'The zip expands past 20 MB.');
    return Buffer.from(data);
  };
  const petJson = pick('pet.json');
  const meta = parsePetJson(petJson);
  const sheetName = meta.spritesheet ?? files.find((f) => /\.(webp|png)$/i.test(f.name))?.name ?? null;
  if (!sheetName || sheetName.includes('/') || sheetName.includes('..'))
    throw new AvatarImportError('sheet_missing', 'pet.json doesn’t name a sprite sheet in the zip.');
  const extra = files.filter((f) => f.name !== 'pet.json' && f.name !== sheetName);
  if (extra.length)
    throw new AvatarImportError(
      'zip_extra_files',
      `The zip has extra files (${extra
        .map((e) => e.name)
        .slice(0, 3)
        .join(', ')}). Sprite kits hold only pet.json and the sprite sheet.`,
    );
  if (!files.some((f) => f.name === sheetName)) throw new AvatarImportError('sheet_missing', `pet.json names “${sheetName}”, but it isn’t in the zip.`);
  return { petJson, sheet: pick(sheetName), sheetName };
}

export interface Layout {
  version: 1 | 2 | null;
  cols: number;
  rows: number;
  /** For sheets that aren't an exact ChatGPT size: where each frame is (see `SheetFrames`). */
  frames?: SheetFrames;
}

/**
 * Where every frame of a sheet sits: one entry per row (top to bottom) with each figure's span
 * (left to right). Every frame is cut `cropW` wide around its figure and the height of its row,
 * keeping only art nearer that figure than its neighbours, and all frames share one scale, so
 * animations don't jitter.
 */
export interface SheetFrames {
  cropW: number;
  /** The tallest row; with `cropW`, sets the one scale for the whole sheet. */
  cropH: number;
  /**
   * Each row is cut exactly from `top` to `bottom`, so neighbouring rows stay out; `spans` are
   * where each figure starts and ends across it.
   */
  rows: { top: number; bottom: number; spans: [number, number][] }[];
}

/** Frames of an evenly divided sheet. */
function evenFrames(w: number, h: number, cols: number, rows: number): SheetFrames {
  const cw = w / cols;
  const ch = h / rows;
  return {
    cropW: cw,
    cropH: ch,
    rows: Array.from({ length: rows }, (_, r) => ({
      top: Math.round(r * ch),
      bottom: Math.round((r + 1) * ch),
      spans: Array.from({ length: cols }, (_, c) => [Math.round(c * cw), Math.round((c + 1) * cw)] as [number, number]),
    })),
  };
}

/** Smallest cell width (px) worth importing; below this the art is too small to use. */
const MIN_CELL_W = 48;

/**
 * FR-A3: work out the layout. Exact ChatGPT sizes are known grids. Any other size is read from
 * the art: rows from the gaps between them, then each figure in each row on its own, so rows
 * may differ in frame count and spacing. If the art doesn't say, the owner confirms a grid.
 * Non-standard sheets are rebuilt as 192 × 208 cells by `buildRuntimeSheet`.
 */
export function detectLayout(w: number, h: number, manual?: { cols?: number; rows?: number }, raw?: Buffer): Layout {
  const { cellW, cellH, cols: COLS, v1, v2 } = PET_FORMAT;
  if (w === v1.w && h === v1.h) return { version: 1, cols: COLS, rows: v1.rows };
  if (w === v2.w && h === v2.h) return { version: 2, cols: COLS, rows: v2.rows };
  if (manual?.cols && manual?.rows && w / manual.cols >= MIN_CELL_W) {
    // Cut along the gaps for that many rows and columns when the art shows them.
    const fit = raw ? detectFrames(raw, w, h, { cols: manual.cols, rows: manual.rows }) : null;
    return { version: null, cols: manual.cols, rows: manual.rows, frames: fit ?? evenFrames(w, h, manual.cols, manual.rows) };
  }
  const found = raw ? detectFrames(raw, w, h) : null;
  if (found) {
    const cols = Math.max(1, ...found.rows.map((r) => r.spans.length));
    const rows = found.rows.length;
    const version = cols === COLS && rows === v1.rows ? 1 : cols === COLS && rows === v2.rows ? 2 : null;
    return { version, cols, rows, frames: found };
  }
  let guess: { cols: number; rows: number } | null = null;
  if (w % cellW === 0 && h % cellH === 0) guess = { cols: w / cellW, rows: h / cellH };
  else if (w / COLS >= MIN_CELL_W) {
    // Eight frames across (like ChatGPT's), rows of the same cell shape at this scale.
    const rows = h / ((w / COLS) * (cellH / cellW));
    if (Math.round(rows) >= 1 && Math.abs(rows - Math.round(rows)) <= 0.1) guess = { cols: COLS, rows: Math.round(rows) };
  }
  if (guess)
    throw new AvatarImportError(
      'grid_unknown',
      `This sheet looks like a ${guess.cols} × ${guess.rows} grid, but we couldn’t find the frames in it on our own. Confirm the grid to continue.`,
      { needsGrid: guess, detectedSize: { w, h } },
    );
  throw new AvatarImportError(
    'size_unsupported',
    `This image is ${w} × ${h}, and we couldn’t find rows of animation frames in it. Upload a sprite sheet with the frames in rows on a transparent background, like ChatGPT’s Download sprite kit.`,
    { detectedSize: { w, h } },
  );
}

/** Most columns a sheet may have. */
const MAX_GRID = 16;
/** Most rows (views) a sheet may have; view picks are stored as row numbers up to 63. */
const MAX_ROWS = 64;
/** A row or column may be this much shorter or longer than the average one. */
const BAND_SLACK = 0.4;
/**
 * A column cut counts as falling in a gap when that line is at most this share as busy as the
 * busiest one. Strict, because columns that only long animations use are quiet but not empty.
 */
const GAP_LEVEL = 0.15;

/** Share of each line (row of pixels, or column) that has art on it. */
function busyLines(raw: Buffer, w: number, h: number) {
  const rows = new Float64Array(h);
  const cols = new Float64Array(w);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (raw[(y * w + x) * 4 + 3]! > ALPHA_MIN) {
        rows[y]! += 1 / w;
        cols[x]! += 1 / h;
      }
  return { rows, cols };
}

/**
 * The best n − 1 cuts through `busy`: bands of roughly even length (within BAND_SLACK), cutting
 * through the emptiest lines. Returns the edges and the busiest cut, or null if no layout fits.
 */
function bestCuts(busy: Float64Array, n: number): { edges: number[]; worst: number; uneven: number } | null {
  const len = busy.length;
  if (n === 1) return { edges: [0, len], worst: 0, uneven: 0 };
  const ideal = len / n;
  // Within an empty gap every line costs nothing, so lean gently towards even spacing.
  const nudge = (1e-3 * Math.max(...busy)) / ideal;
  const lo = Math.max(1, Math.ceil(ideal * (1 - BAND_SLACK)));
  const hi = Math.floor(ideal * (1 + BAND_SLACK));
  // cost[k][p]: least total busyness of k cuts with the k-th at p.
  let prev = new Float64Array(len + 1).fill(Infinity);
  prev[0] = 0;
  const from: Int32Array[] = [];
  for (let k = 1; k <= n; k++) {
    const cur = new Float64Array(len + 1).fill(Infinity);
    const back = new Int32Array(len + 1).fill(-1);
    const pFrom = k === n ? len : lo * k;
    const pTo = k === n ? len : Math.min(len - lo, hi * k);
    for (let p = pFrom; p <= pTo; p++) {
      const here = k === n ? 0 : busy[p]! + nudge * Math.abs(p - k * ideal);
      for (let q = Math.max(0, p - hi); q <= p - lo; q++) {
        const c = prev[q]! + here;
        if (c < cur[p]!) {
          cur[p] = c;
          back[p] = q;
        }
      }
    }
    from.push(back);
    prev = cur;
  }
  if (!Number.isFinite(prev[len]!)) return null;
  const edges = [len];
  for (let k = n - 1; k >= 0; k--) edges.unshift(from[k]![edges[0]!]!);
  const worst = Math.max(...edges.slice(1, -1).map((e) => busy[e]!));
  // How far the most off-size band is from the average, as a share of it.
  const uneven = Math.max(...edges.slice(1).map((e, i) => Math.abs(e - edges[i]! - ideal) / ideal));
  return { edges, worst, uneven };
}

/**
 * Columns: the most bands whose cuts all fall in gaps (more would cut through figures) and that
 * each hold some art; or the best edges for a fixed count.
 */
function bands(busy: Float64Array, fixed?: number): number[] | null {
  const level = GAP_LEVEL * Math.max(...busy);
  if (fixed) return bestCuts(busy, fixed)?.edges ?? null;
  const hasArt = (edges: number[]) => edges.slice(1).every((end, i) => busy.subarray(edges[i]!, end).some((v) => v > level));
  let best: number[] | null = null;
  for (let n = 2; n <= MAX_GRID && busy.length / n >= MIN_CELL_W * 0.5; n++) {
    const cut = bestCuts(busy, n);
    if (cut && cut.worst <= level && hasArt(cut.edges)) best = cut.edges;
  }
  return best;
}

/** Frames are roughly as tall as they are wide: row height stays within this range of column width. */
const ROW_TO_COL = [0.7, 1.6] as const;
/** Looser gap level for rows, where hair and feet often reach across. */
const ROW_GAP_LEVEL = 0.6;

/** How much an uneven grid counts against a row count, next to how busy its cuts are. */
const UNEVEN_WEIGHT = 0.5;

/**
 * Rows: of the counts whose rows are a sensible height (`[shortest, tallest]`), the one whose cuts
 * are cleanest and most evenly spaced (an empty row can be cut more than one way).
 */
function rowBands(busy: Float64Array, range: [number, number]): number[] | null {
  // Tall sheets: search a shrunken profile (each line the quietest of its block, so gaps survive),
  // then move each cut to the quietest line near it at full size.
  const f = Math.ceil(busy.length / ROW_SEARCH_LINES);
  if (f <= 1) return rowBandsAt(busy, range);
  const small = new Float64Array(Math.ceil(busy.length / f)).map((_, i) => Math.min(...busy.subarray(i * f, (i + 1) * f)));
  const coarse = rowBandsAt(small, [range[0] / f, range[1] / f]);
  if (!coarse) return null;
  return coarse.map((e, i) => {
    if (i === 0) return 0;
    if (i === coarse.length - 1) return busy.length;
    let at = Math.min(busy.length - 1, e * f);
    for (let y = Math.max(0, (e - 1) * f); y < Math.min(busy.length, (e + 1) * f); y++) if (busy[y]! < busy[at]!) at = y;
    return at;
  });
}

/** Row search works on at most this many lines (cost grows with the square of it). */
const ROW_SEARCH_LINES = 1200;

function rowBandsAt(busy: Float64Array, [shortest, tallest]: [number, number]): number[] | null {
  const max = Math.max(...busy);
  let best: { edges: number[]; score: number } | null = null;
  for (let n = Math.max(1, Math.floor(busy.length / tallest)); n <= Math.min(MAX_ROWS, Math.ceil(busy.length / shortest)); n++) {
    const height = busy.length / n;
    if (height > tallest || height < shortest) continue;
    const cut = bestCuts(busy, n);
    if (!cut || cut.worst > ROW_GAP_LEVEL * max) continue;
    const score = cut.worst / max + UNEVEN_WEIGHT * cut.uneven;
    if (!best || score < best.score) best = { edges: cut.edges, score };
  }
  return best?.edges ?? null;
}

/** Lines this share as busy as a row's busiest are part of a figure (lower is gap). */
const FIGURE_LEVEL = 0.04;
/** Gaps narrower than this share of a column are inside one figure (between legs, say). */
const MIN_GAP = 0.08;
/** Pieces narrower than this share of a column are effects or scraps, not figures. */
const MIN_FIGURE = 0.25;
/** …and are kept with the nearest figure when within this share of a column of it. */
const ATTACH = 0.35;
/** Frames are cut this many columns wide (room for arms out and lying down), or the widest figure. */
const CROP_W = 1.25;
/** …and at most this many columns wide. */
const MAX_CROP = 1.5;

/** The figures across one row: [start, end) of each, from that row's own column profile. */
function figuresInRow(busy: Float64Array, colWidth: number): [number, number][] {
  const max = Math.max(...busy);
  if (max === 0) return [];
  let runs: [number, number][] = [];
  for (let x = 0; x < busy.length; x++) {
    if (busy[x]! <= FIGURE_LEVEL * max) continue;
    const last = runs.at(-1);
    if (last && x - last[1] < MIN_GAP * colWidth) last[1] = x + 1;
    else runs.push([x, x + 1]);
  }
  // Sparkles and scraps join the figure next to them, or go.
  const big = runs.filter(([a, b]) => b - a >= MIN_FIGURE * colWidth);
  for (const [a, b] of runs) {
    if (b - a >= MIN_FIGURE * colWidth) continue;
    const near = big.map((r) => ({ r, d: Math.max(r[0] - b, a - r[1], 0) })).sort((p, q) => p.d - q.d)[0];
    if (near && near.d <= ATTACH * colWidth) {
      near.r[0] = Math.min(near.r[0], a);
      near.r[1] = Math.max(near.r[1], b);
    }
  }
  runs = big.sort((p, q) => p[0] - q[0]);
  // Figures that touch (arms out, say) are split at their quietest lines.
  return runs.flatMap(([a, b]) => {
    const n = Math.round((b - a) / colWidth);
    if (n < 2) return [[a, b] as [number, number]];
    const cuts = bestCuts(busy.subarray(a, b), n)?.edges ?? [0, b - a];
    return cuts.slice(1).map((e, i) => [a + cuts[i]!, a + e] as [number, number]);
  });
}

/** Shapes are measured on a copy at most this many pixels across (fast, and joins anti-aliasing). */
const MEASURE_SIZE = 400;
/** Shapes smaller than this share of the largest are effects or scraps, not figures. */
const MEASURE_MIN = 0.15;

/** The typical figure's width and height: the median size of the separate shapes on the sheet. */
function typicalFigure(raw: Buffer, w: number, h: number): { w: number; h: number } | null {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / MEASURE_SIZE));
  const sw = Math.ceil(w / f);
  const sh = Math.ceil(h / f);
  const on = new Uint8Array(sw * sh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (raw[(y * w + x) * 4 + 3]! > ALPHA_MIN) on[Math.floor(y / f) * sw + Math.floor(x / f)] = 1;
  const seen = new Uint8Array(sw * sh);
  const stack = new Int32Array(sw * sh);
  const shapes: { area: number; w: number; h: number }[] = [];
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || seen[s]) continue;
    let top = 0;
    let area = 0;
    let [x0, y0, x1, y1] = [sw, sh, 0, 0];
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top]!;
      const x = i % sw;
      const y = (i - x) / sw;
      area++;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const j = ny * sw + nx;
          if (nx >= 0 && ny >= 0 && nx < sw && ny < sh && on[j] && !seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
    }
    shapes.push({ area, w: (x1 - x0 + 1) * f, h: (y1 - y0 + 1) * f });
  }
  const biggest = Math.max(0, ...shapes.map((s) => s.area));
  const figures = shapes.filter((s) => s.area >= MEASURE_MIN * biggest);
  if (figures.length < 2) return null;
  const median = (xs: number[]) => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)]!;
  return { w: median(figures.map((s) => s.w)), h: median(figures.map((s) => s.h)) };
}

/** Without common columns, a frame's width is the typical figure's plus a little room. */
const FREE_COL = 1.25;
/** …and a row is between this many figure heights tall. */
const FREE_ROW_TO_FIGURE = [1.0, 2.0] as const;

/**
 * Find every frame in a sheet whose size doesn't say its layout. Rows come from the gaps between
 * them (they needn't be perfectly even); then each row's figures are found on their own, so rows
 * may hold different numbers of frames at different spacing. With `fixed`, cuts that many rows
 * and columns along the gaps instead. Null when the art is unclear.
 */
export function detectFrames(raw: Buffer, w: number, h: number, fixed?: { cols: number; rows: number }): SheetFrames | null {
  const busy = busyLines(raw, w, h);
  const xs = bands(busy.cols, fixed?.cols);
  if (fixed) {
    const ys = bands(busy.rows, fixed.rows);
    if (!xs || !ys) return null;
    return {
      cropW: w / fixed.cols,
      cropH: h / fixed.rows,
      rows: ys.slice(1).map((bottom, r) => ({ top: ys[r]!, bottom, spans: xs.slice(1).map((end, c) => [xs[c]!, end] as [number, number]) })),
    };
  }
  let colWidth: number;
  let rowRange: [number, number];
  if (xs) {
    colWidth = w / (xs.length - 1);
    rowRange = [ROW_TO_COL[0] * colWidth, ROW_TO_COL[1] * colWidth];
  } else {
    // No common columns: size things from the figures themselves.
    const figure = typicalFigure(raw, w, h);
    if (!figure) return null;
    colWidth = FREE_COL * figure.w;
    rowRange = [FREE_ROW_TO_FIGURE[0] * figure.h, FREE_ROW_TO_FIGURE[1] * figure.h];
  }
  if (colWidth < MIN_CELL_W * 0.5) return null;
  const ys = rowBands(busy.rows, rowRange);
  if (!ys || ys.length < 2) return null;

  const rows = ys.slice(1).map((end, r) => {
    const top = ys[r]!;
    const inRow = new Float64Array(w);
    for (let y = top; y < end; y++) for (let x = 0; x < w; x++) if (raw[(y * w + x) * 4 + 3]! > ALPHA_MIN) inRow[x]! += 1 / (end - top);
    return { top, end, figures: figuresInRow(inRow, colWidth) };
  });
  if (!rows.some((r) => r.figures.length)) return null;
  const widest = Math.max(...rows.flatMap((r) => r.figures.map(([a, b]) => b - a)));
  return {
    cropW: Math.min(MAX_CROP * colWidth, Math.max(CROP_W * colWidth, widest)),
    cropH: Math.max(...rows.map((r) => r.end - r.top)),
    rows: rows.map((r) => ({ top: r.top, bottom: r.end, spans: r.figures })),
  };
}

/** Pixels at or under this alpha count as empty. */
const ALPHA_MIN = 8;
/** Edge scraps smaller than this share of a cell are always dropped (even if they're all there is). */
const SCRAP_OF_CELL = 0.02;
/** Edge pieces smaller than this share of a cell's main figure are a neighbour's, not part of it. */
const SCRAP_OF_FIGURE = 0.25;

/**
 * Sheets pack frames tightly, so a figure's feet or hat often reach into the cell above or
 * below (or beside). In each cell, keep the figure and anything floating inside the cell
 * (sparkles, dust), and clear small separate pieces that touch the cell's edge: those belong
 * to a neighbouring frame. Returns a cleaned copy; the input is untouched.
 */
export function isolateCells(raw: Buffer, w: number, layout: Layout, cellW: number = PET_FORMAT.cellW, cellH: number = PET_FORMAT.cellH): Buffer {
  const out = Buffer.from(raw);
  const label = new Int32Array(cellW * cellH);
  const stack = new Int32Array(cellW * cellH);
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const x0 = c * cellW;
      const y0 = r * cellH;
      const alpha = (i: number) => out[((y0 + Math.floor(i / cellW)) * w + x0 + (i % cellW)) * 4 + 3]!;
      label.fill(0);
      const parts: { size: number; edge: boolean }[] = [{ size: 0, edge: false }];
      for (let start = 0; start < label.length; start++) {
        if (label[start] || alpha(start) <= ALPHA_MIN) continue;
        // Flood fill one 8-connected piece.
        const id = parts.length;
        const part = { size: 0, edge: false };
        parts.push(part);
        let top = 0;
        stack[top++] = start;
        label[start] = id;
        while (top) {
          const i = stack[--top]!;
          const x = i % cellW;
          const y = (i - x) / cellW;
          part.size++;
          if (x === 0 || y === 0 || x === cellW - 1 || y === cellH - 1) part.edge = true;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= cellH) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= cellW) continue;
              const j = ny * cellW + nx;
              if (!label[j] && alpha(j) > ALPHA_MIN) {
                label[j] = id;
                stack[top++] = j;
              }
            }
          }
        }
      }
      // Near-invisible pixels (faint halos, compression noise) become fully transparent.
      for (let i = 0; i < label.length; i++) {
        if (label[i]) continue;
        const o = ((y0 + Math.floor(i / cellW)) * w + x0 + (i % cellW)) * 4;
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      }
      if (parts.length === 1) continue;
      const figure = Math.max(...parts.map((p) => p.size));
      const drop = parts.map((p) => p.edge && (p.size < SCRAP_OF_CELL * cellW * cellH || (p.size !== figure && p.size < SCRAP_OF_FIGURE * figure)));
      if (!drop.some(Boolean)) continue;
      for (let i = 0; i < label.length; i++) {
        if (!drop[label[i]!]) continue;
        const o = ((y0 + Math.floor(i / cellW)) * w + x0 + (i % cellW)) * 4;
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      }
    }
  }
  return out;
}

/** FR-A5: frames per row = leading non-transparent cells. */
export function countFrames(raw: Buffer, w: number, layout: Layout, cellW: number = PET_FORMAT.cellW, cellH: number = PET_FORMAT.cellH): number[] {
  const counts: number[] = [];
  for (let r = 0; r < layout.rows; r++) {
    let n = 0;
    for (let c = 0; c < layout.cols; c++) {
      if (!cellHasPixels(raw, w, c * cellW, r * cellH, cellW, cellH)) break;
      n++;
    }
    counts.push(n);
  }
  return counts;
}

function cellHasPixels(raw: Buffer, w: number, x0: number, y0: number, cw: number, ch: number): boolean {
  for (let y = y0; y < y0 + ch; y++) {
    let i = (y * w + x0) * 4 + 3;
    for (let x = 0; x < cw; x++, i += 4) if (raw[i]! > 8) return true;
  }
  return false;
}

export interface SourceView {
  row: number;
  name: string;
  frames: number;
}

/** Cell size of the views sheet used to pick which view plays where. */
export const VIEW_CELL = { w: 48, h: 52 } as const;

export interface BuiltSheet {
  sheet: Buffer;
  thumb: Buffer;
  rows: { state: AvatarState; frames: number; dimmed?: boolean; at: number }[];
  /** Every non-empty source row, and a small sheet of them (one row each, in this order). */
  views: SourceView[];
  viewsSheet: Buffer;
  /** The pose (key) each state shows. */
  choices: Record<string, number>;
  frameCounts: Record<string, number>;
  issues: AvatarValidationIssue[];
  layout: Layout;
  size: { w: number; h: number };
}

/** FR-A2, A3, A5, A6, A18: validate a sheet and build the Spinroom runtime sheet + thumbnail. */
/** [colour quality, alpha quality] pairs tried in order until the sheet fits the size budget. */
const WEBP_LADDER: readonly (readonly [number, number])[] = [
  [88, 90],
  [82, 80],
  [76, 70],
  [70, 60],
  [62, 50],
  [55, 40],
];

export async function buildRuntimeSheet(
  input: Buffer,
  manualGrid?: { cols?: number; rows?: number },
  /** Owner's picks: state → source row. Empty or out-of-range picks use the default mapping. */
  picks: Record<string, number | undefined> = {},
): Promise<BuiltSheet> {
  const kind = sniff(input);
  if (kind !== 'png' && kind !== 'webp') {
    throw new AvatarImportError('format_unsupported', 'Upload a PNG or WebP sprite sheet, or the .codex-pet.zip from Download sprite kit.');
  }
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new AvatarImportError('image_invalid', 'That image can’t be read — export it again as PNG or WebP.');
  }
  if ((meta.pages ?? 1) > 1) throw new AvatarImportError('image_animated', 'Animated images aren’t supported. Use the still sprite sheet from ChatGPT.');
  if (!meta.hasAlpha)
    throw new AvatarImportError('no_alpha', 'The sheet has no transparency. ChatGPT pet sheets have a transparent background — use Download sprite kit.');
  const size = { w: meta.width!, h: meta.height! };
  const exact = (size.w === PET_FORMAT.v1.w && size.h === PET_FORMAT.v1.h) || (size.w === PET_FORMAT.v2.w && size.h === PET_FORMAT.v2.h);
  const srcRaw = exact ? null : await sharp(input).ensureAlpha().raw().toBuffer();
  const layout = detectLayout(size.w, size.h, manualGrid, srcRaw ?? undefined);
  const w = layout.cols * PET_FORMAT.cellW;
  // Other sizes: each frame is scaled into a standard 192 × 208 cell, keeping its proportions.
  const cells = srcRaw ? await normalizeCells(srcRaw, size, layout) : await sharp(input).ensureAlpha().raw().toBuffer();
  // Art often spills a little past its cell; drop the neighbours' scraps before anything else.
  const raw = isolateCells(cells, w, layout);
  const counts = countFrames(raw, w, layout);

  const issues: AvatarValidationIssue[] = [];
  const petRows = AVATAR_MAPPING.petRows;
  const rowIndex = (name: string) => petRows.indexOf(name);
  const idleRow = rowIndex('idle');
  if (!counts[idleRow])
    throw new AvatarImportError('idle_empty', 'The idle row (first row) is empty. Every pet needs idle frames — check the sheet or re-download it.');

  // Uploaded avatars are still poses: each state shows one figure (row, frame) from the sheet.
  const plan: { state: AvatarState; row: number; frame: number; dimmed?: boolean }[] = [];
  const frameCounts: Record<string, number> = {};
  for (const m of AVATAR_MAPPING.states) {
    const idx = rowIndex(m.row);
    const frames = idx >= 0 && idx < layout.rows ? (counts[idx] ?? 0) : 0;
    frameCounts[m.row] = frames;
    const pick = picks[m.state] === undefined ? null : poseOf(picks[m.state]!);
    if (pick && pick.row < layout.rows && pick.frame < (counts[pick.row] ?? 0)) plan.push({ state: m.state, ...pick });
    else if (frames > 0) plan.push({ state: m.state, row: idx, frame: 0 });
    else {
      issues.push({
        level: 'warning',
        code: `row_empty_${m.row}`,
        message: `The ${m.row} row is empty, so ${m.state === 'away' ? 'away' : m.state} will use the idle pose.`,
      });
      plan.push({ state: m.state, row: idleRow, frame: 0, ...(m.dimWhenFallback ? { dimmed: true } : {}) });
    }
  }

  const cw = RUNTIME_SHEET.cellW;
  const ch = RUNTIME_SHEET.cellH;
  const cellAt = async (row: number, frame: number) => {
    const { cellW: sw, cellH: sh } = PET_FORMAT;
    return sharp(cropRaw(raw, w, frame * sw, row * sh, sw, sh), { raw: { width: sw, height: sh, channels: 4 } })
      .resize(cw, ch, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
  };
  // States showing the same pose share one cell; the runtime sheet is one cell per pose, stacked.
  const poses = [...new Set(plan.map((p) => poseKey(p.row, p.frame)))];
  const composites: OverlayOptions[] = [];
  for (let i = 0; i < poses.length; i++) {
    const { row, frame } = poseOf(poses[i]!);
    composites.push({ input: await cellAt(row, frame), left: 0, top: i * ch });
  }
  const flat = await sharp({ create: { width: cw, height: poses.length * ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png()
    .toBuffer();
  let sheet: Buffer | null = null;
  // Detailed, anti-aliased art is dominated by the alpha channel: step both qualities down together.
  for (const [quality, alphaQuality] of WEBP_LADDER) {
    // Re-encoding through sharp drops all metadata (FR-A6).
    const out = await sharp(flat).webp({ quality, alphaQuality, effort: 6 }).toBuffer();
    if (out.length <= RUNTIME_SHEET.maxBytes) {
      sheet = out;
      break;
    }
  }
  if (!sheet) throw new AvatarImportError('sheet_too_large', 'This pet is too detailed to shrink under 150 KB. Try a simpler pet.');

  const thumb = await sharp(await cellAt(idleRow, 0))
    .resize(RUNTIME_SHEET.thumbSize, RUNTIME_SHEET.thumbSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const views: SourceView[] = counts.flatMap((frames, row) => (frames ? [{ row, name: petRows[row] ?? `row-${row + 1}`, frames }] : []));
  const viewsSheet = await buildViewsSheet(raw, w, views, layout.cols);

  return {
    sheet,
    thumb,
    rows: plan.map((p) => ({ state: p.state, frames: 1, at: poses.indexOf(poseKey(p.row, p.frame)), ...(p.dimmed ? { dimmed: true } : {}) })),
    views,
    viewsSheet,
    choices: Object.fromEntries(plan.map((p) => [p.state, poseKey(p.row, p.frame)])),
    frameCounts,
    issues,
    layout,
    size,
  };
}

/** Copy a box out of a raw RGBA image (much cheaper than a sharp pipeline over a large sheet). */
function cropRaw(raw: Buffer, w: number, left: number, top: number, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) raw.copy(out, y * width * 4, ((top + y) * w + left) * 4, ((top + y) * w + left + width) * 4);
  return out;
}

/** A small sheet of every pose (one sheet row per row of figures), so owners can pick any of them. */
async function buildViewsSheet(raw: Buffer, w: number, views: SourceView[], cols: number): Promise<Buffer> {
  const { w: vw, h: vh } = VIEW_CELL;
  const rows = raw.length / 4 / w / PET_FORMAT.cellH;
  // Shrink the whole sheet once, then keep the rows that have figures.
  const small = await sharp(raw, { raw: { width: w, height: rows * PET_FORMAT.cellH, channels: 4 } })
    .resize(cols * vw, rows * vh, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const strip = cols * vw * vh * 4;
  const out = Buffer.concat(views.map((v) => small.subarray(v.row * strip, (v.row + 1) * strip)));
  return sharp(views.length ? out : Buffer.alloc(cols * vw * vh * 4), { raw: { width: cols * vw, height: Math.max(1, views.length) * vh, channels: 4 } })
    .webp({ quality: 80, alphaQuality: 80, effort: 6 })
    .toBuffer();
}

/**
 * Rebuild a sheet of any size as standard 192 × 208 cells (raw RGBA): each frame is cut around
 * its figure and scaled by one factor for the whole sheet, centred in its cell. Row r, frame c of
 * `frames` lands in cell (r, c).
 */
async function normalizeCells(raw: Buffer, size: { w: number; h: number }, layout: Layout): Promise<Buffer> {
  const { cellW, cellH } = PET_FORMAT;
  const frames = layout.frames ?? evenFrames(size.w, size.h, layout.cols, layout.rows);
  const scale = Math.min(cellW / frames.cropW, cellH / frames.cropH);
  // Scale the whole sheet once; every frame is then copied out of it directly.
  const sw = Math.max(1, Math.round(size.w * scale));
  const sh = Math.max(1, Math.round(size.h * scale));
  const scaled = await sharp(raw, { raw: { width: size.w, height: size.h, channels: 4 } })
    .resize(sw, sh, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const outW = layout.cols * cellW;
  const out = Buffer.alloc(outW * layout.rows * cellH * 4);
  for (let r = 0; r < frames.rows.length; r++) {
    const row = frames.rows[r]!;
    for (let c = 0; c < row.spans.length; c++) {
      const [a, b] = row.spans[c]!;
      // Keep only art nearer this figure than its neighbours (fists out can touch the next frame).
      const keepFrom = c > 0 ? ((row.spans[c - 1]![1] + a) / 2) * scale : -Infinity;
      const keepTo = c < row.spans.length - 1 ? ((b + row.spans[c + 1]![0]) / 2) * scale : Infinity;
      // The crop box (scaled), clipped to the image; whatever falls outside stays transparent.
      const x0 = ((a + b) / 2 - frames.cropW / 2) * scale;
      const y0 = row.top * scale;
      const left = Math.max(0, Math.round(x0));
      const top = Math.max(0, Math.round(y0));
      const right = Math.min(sw, Math.round(x0 + frames.cropW * scale));
      const bottom = Math.min(sh, Math.round(row.bottom * scale));
      const pw = right - left;
      const ph = bottom - top;
      if (pw < 2 || ph < 2) continue;
      const box = cropRaw(scaled, sw, left, top, pw, ph);
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < pw; x++) if (left + x < keepFrom || left + x >= keepTo) box.fill(0, (y * pw + x) * 4, (y * pw + x) * 4 + 4);
      // Clear neighbours' pieces at the edges of the cut, then centre it in its cell.
      const piece = isolateCells(box, pw, { version: null, cols: 1, rows: 1 }, pw, ph);
      const offX = Math.max(0, Math.min(cellW - pw, Math.round((cellW - frames.cropW * scale) / 2 + (left - x0))));
      const offY = Math.max(0, Math.min(cellH - ph, Math.round((cellH - (row.bottom - row.top) * scale) / 2 + (top - y0))));
      const w = Math.min(pw, cellW);
      for (let y = 0; y < Math.min(ph, cellH); y++) piece.copy(out, ((r * cellH + offY + y) * outW + c * cellW + offX) * 4, y * pw * 4, (y * pw + w) * 4);
    }
  }
  return out;
}

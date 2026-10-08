import { AVATAR_LIMITS, AVATAR_MAPPING, PET_FORMAT, RUNTIME_SHEET, type AvatarState, type AvatarValidationIssue } from '@spinroom/contracts';
import { unzipSync } from 'fflate';
import sharp, { type Metadata, type OverlayOptions, type Sharp } from 'sharp';

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
  /** Set when the grid was read from the art: the edges to cut along. */
  edges?: { xs: number[]; ys: number[] };
}

/** How far a sheet's proportions may be off a known layout and still count as that layout scaled. */
const ASPECT_TOLERANCE = 0.015;
/** Smallest cell width (px) worth importing; below this the art is too small to use. */
const MIN_CELL_W = 48;

/**
 * FR-A3: detect the grid from dimensions. ChatGPT sheets come in two layouts; copies that were
 * resized (e.g. saved from a preview) are accepted at any scale with the same proportions, and
 * other 8-across grids are offered for the owner to confirm. Non-standard sizes are scaled to
 * 192 × 208 cells by `buildRuntimeSheet`.
 */
export function detectLayout(w: number, h: number, manual?: { cols?: number; rows?: number }, raw?: Buffer): Layout {
  const { cellW, cellH, cols: COLS, v1, v2 } = PET_FORMAT;
  if (w === v1.w && h === v1.h) return { version: 1, cols: COLS, rows: v1.rows };
  if (w === v2.w && h === v2.h) return { version: 2, cols: COLS, rows: v2.rows };
  if (manual?.cols && manual?.rows && w / manual.cols >= MIN_CELL_W) {
    // Cut along the gaps for that many rows and columns when the art shows them.
    const fit = raw ? detectGrid(raw, w, h, { cols: manual.cols, rows: manual.rows }) : null;
    return { version: null, cols: manual.cols, rows: manual.rows, ...(fit ? { edges: { xs: fit.xs, ys: fit.ys } } : {}) };
  }
  // Find the grid from the art itself: the empty gaps between figures.
  const found = raw ? detectGrid(raw, w, h) : null;
  if (found && w / found.cols >= MIN_CELL_W) {
    const version = found.cols === COLS && found.rows === v1.rows ? 1 : found.cols === COLS && found.rows === v2.rows ? 2 : null;
    return { version, cols: found.cols, rows: found.rows, edges: { xs: found.xs, ys: found.ys } };
  }
  const near = (a: number, b: number) => Math.abs(a / b - 1) <= ASPECT_TOLERANCE;
  if (w / COLS >= MIN_CELL_W) {
    if (near(w / h, v1.w / v1.h)) return { version: 1, cols: COLS, rows: v1.rows };
    if (near(w / h, v2.w / v2.h)) return { version: 2, cols: COLS, rows: v2.rows };
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
      `This sheet looks like a ${guess.cols} × ${guess.rows} grid, which isn’t a standard ChatGPT layout. Confirm the grid to continue.`,
      { needsGrid: guess, detectedSize: { w, h } },
    );
  throw new AvatarImportError(
    'size_unsupported',
    `This image is ${w} × ${h}, which doesn’t line up with a ChatGPT pet sheet (8 frames across). Use Download sprite kit in ChatGPT.`,
    { detectedSize: { w, h } },
  );
}

/** Most rows / columns a sheet may have. */
const MAX_GRID = 16;
/** A row or column may be this much shorter or longer than the average one. */
const BAND_SLACK = 0.4;
/**
 * A column cut counts as falling in a gap when that line is at most this share as busy as the
 * busiest one. Strict, because columns that only long animations use are quiet but not empty.
 */
const GAP_LEVEL = 0.15;

/** Where a sheet's rows and columns start and end (n + 1 edges each), found from the art. */
export interface GridEdges {
  cols: number;
  rows: number;
  xs: number[];
  ys: number[];
}

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
 * Rows for a known column width: of the counts that keep frames in proportion, the one whose
 * cuts are cleanest and most evenly spaced (an empty row can be cut more than one way).
 */
function rowBands(busy: Float64Array, colWidth: number): number[] | null {
  const max = Math.max(...busy);
  let best: { edges: number[]; score: number } | null = null;
  for (let n = 1; n <= MAX_GRID; n++) {
    const height = busy.length / n;
    if (height > colWidth * ROW_TO_COL[1] || height < colWidth * ROW_TO_COL[0]) continue;
    const cut = bestCuts(busy, n);
    if (!cut || cut.worst > ROW_GAP_LEVEL * max) continue;
    const score = cut.worst / max + UNEVEN_WEIGHT * cut.uneven;
    if (!best || score < best.score) best = { edges: cut.edges, score };
  }
  return best?.edges ?? null;
}

/**
 * The grid of a sheet whose size doesn't say it, read from the empty gaps between figures.
 * Rows and columns needn't be perfectly even (sheets drawn by image models rarely are). With
 * `fixed`, finds the best edges for that many rows and columns. Null when the art is unclear.
 */
export function detectGrid(raw: Buffer, w: number, h: number, fixed?: { cols: number; rows: number }): GridEdges | null {
  const busy = busyLines(raw, w, h);
  const xs = bands(busy.cols, fixed?.cols);
  if (!xs) return null;
  const ys = fixed ? bands(busy.rows, fixed.rows) : rowBands(busy.rows, w / (xs.length - 1));
  return ys ? { cols: xs.length - 1, rows: ys.length - 1, xs, ys } : null;
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
  /** The source row each state plays. */
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
/** When thinning a busy sheet, rows with fewer frames than this keep them all. */
const THIN_KEEP_UNDER = 5;

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
  const h = layout.rows * PET_FORMAT.cellH;
  // Other sizes: each frame is scaled into a standard 192 × 208 cell, keeping its proportions.
  if (srcRaw && (size.w !== w || size.h !== h)) input = await normalizeCells(srcRaw, size, layout);
  // Art often spills a little past its cell; drop the neighbours' scraps before anything else.
  const raw = isolateCells(await sharp(input).ensureAlpha().raw().toBuffer(), w, layout);
  const clean = () => sharp(raw, { raw: { width: w, height: h, channels: 4 } });
  const counts = countFrames(raw, w, layout);

  const issues: AvatarValidationIssue[] = [];
  const petRows = AVATAR_MAPPING.petRows;
  const rowIndex = (name: string) => petRows.indexOf(name);
  const idleRow = rowIndex('idle');
  if (!counts[idleRow])
    throw new AvatarImportError('idle_empty', 'The idle row (first row) is empty. Every pet needs idle frames — check the sheet or re-download it.');

  const plan: { state: AvatarState; srcRow: number; frames: number; dimmed?: boolean }[] = [];
  const frameCounts: Record<string, number> = {};
  for (const m of AVATAR_MAPPING.states) {
    const idx = rowIndex(m.row);
    const frames = idx >= 0 && idx < layout.rows ? (counts[idx] ?? 0) : 0;
    frameCounts[m.row] = frames;
    const pick = picks[m.state];
    if (pick !== undefined && pick < layout.rows && counts[pick]) plan.push({ state: m.state, srcRow: pick, frames: counts[pick] });
    else if (frames > 0) plan.push({ state: m.state, srcRow: idx, frames });
    else {
      issues.push({
        level: 'warning',
        code: `row_empty_${m.row}`,
        message: `The ${m.row} row is empty, so ${m.state === 'away' ? 'away' : m.state} will use the idle animation.`,
      });
      plan.push({ state: m.state, srcRow: idleRow, frames: counts[idleRow]!, ...(m.dimWhenFallback ? { dimmed: true } : {}) });
    }
  }

  const cw = RUNTIME_SHEET.cellW;
  const ch = RUNTIME_SHEET.cellH;
  const cellCache = new Map<string, Buffer>();
  const cellAt = async (row: number, frame: number) => {
    const key = `${row}:${frame}`;
    let cell = cellCache.get(key);
    if (!cell) {
      cell = await clean()
        .extract({ left: frame * PET_FORMAT.cellW, top: row * PET_FORMAT.cellH, width: PET_FORMAT.cellW, height: PET_FORMAT.cellH })
        .resize(cw, ch, { kernel: 'lanczos3' })
        .png()
        .toBuffer();
      cellCache.set(key, cell);
    }
    return cell;
  };
  /** Frame indices kept per row: all of them, or every other one for long rows (busy sheets). */
  const keptFrames = (frames: number, thin: boolean) =>
    Array.from({ length: frames }, (_, i) => i).filter((i) => !thin || frames <= THIN_KEEP_UNDER || i % 2 === 0);
  // States that play the same source row share one sheet row.
  const sources = [...new Set(plan.map((p) => p.srcRow))];
  const sheetRow = (srcRow: number) => sources.indexOf(srcRow);
  const compose = async (thin: boolean) => {
    const composites: OverlayOptions[] = [];
    const kept = sources.map((src) => keptFrames(counts[src]!, thin));
    for (let r = 0; r < sources.length; r++) {
      const frames = kept[r]!;
      for (let f = 0; f < frames.length; f++) composites.push({ input: await cellAt(sources[r]!, frames[f]!), left: f * cw, top: r * ch });
    }
    const maxFrames = Math.max(...kept.map((k) => k.length));
    const flat = await sharp({ create: { width: maxFrames * cw, height: sources.length * ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(composites)
      .png()
      .toBuffer();
    return { flat, frames: kept.map((k) => k.length) };
  };

  // Detailed, anti-aliased art (e.g. ChatGPT pet sheets) is dominated by the alpha channel, so
  // step colour and alpha quality down together; as a last resort, drop every other frame.
  let sheet: Buffer | null = null;
  let rowFrames = sources.map((src) => counts[src]!);
  for (const thin of [false, true]) {
    const built = await compose(thin);
    for (const [quality, alphaQuality] of WEBP_LADDER) {
      // Re-encoding through sharp drops all metadata (FR-A6).
      const out = await sharp(built.flat).webp({ quality, alphaQuality, effort: 6 }).toBuffer();
      if (out.length <= RUNTIME_SHEET.maxBytes) {
        sheet = out;
        break;
      }
    }
    if (sheet) {
      rowFrames = built.frames;
      if (thin)
        issues.push({
          level: 'warning',
          code: 'frames_reduced',
          message: 'This pet is very detailed, so long animations keep every other frame to stay small enough to load quickly.',
        });
      break;
    }
  }
  if (!sheet)
    throw new AvatarImportError(
      'sheet_too_large',
      'This pet is too detailed to shrink under 150 KB, even with fewer frames. Try a simpler pet or one with fewer frames.',
    );

  const firstIdle = await cellAt(idleRow, 0);
  const thumb = await sharp(firstIdle)
    .resize(RUNTIME_SHEET.thumbSize, RUNTIME_SHEET.thumbSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const views: SourceView[] = counts.flatMap((frames, row) => (frames ? [{ row, name: petRows[row] ?? `row-${row + 1}`, frames }] : []));
  const viewsSheet = await buildViewsSheet(clean, views, layout.cols);

  return {
    sheet,
    thumb,
    rows: plan.map((p) => {
      const at = sheetRow(p.srcRow);
      return { state: p.state, frames: rowFrames[at]!, at, ...(p.dimmed ? { dimmed: true } : {}) };
    }),
    views,
    viewsSheet,
    choices: Object.fromEntries(plan.map((p) => [p.state, p.srcRow])),
    frameCounts,
    issues,
    layout,
    size,
  };
}

/** A small sheet with one row per view, so owners can see every animation and pick one. */
async function buildViewsSheet(source: () => Sharp, views: SourceView[], cols: number): Promise<Buffer> {
  const { w, h } = VIEW_CELL;
  const composites: OverlayOptions[] = [];
  for (let r = 0; r < views.length; r++) {
    for (let f = 0; f < views[r]!.frames; f++) {
      const cell = await source()
        .extract({ left: f * PET_FORMAT.cellW, top: views[r]!.row * PET_FORMAT.cellH, width: PET_FORMAT.cellW, height: PET_FORMAT.cellH })
        .resize(w, h, { kernel: 'lanczos3' })
        .png()
        .toBuffer();
      composites.push({ input: cell, left: f * w, top: r * h });
    }
  }
  return sharp({ create: { width: cols * w, height: Math.max(1, views.length) * h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .webp({ quality: 80, alphaQuality: 80, effort: 6 })
    .toBuffer();
}

/** Rebuild a sheet of any size as standard 192 × 208 cells, each frame fitted without stretching. */
async function normalizeCells(raw: Buffer, size: { w: number; h: number }, layout: Layout): Promise<Buffer> {
  const { cellW, cellH } = PET_FORMAT;
  const src = () => sharp(raw, { raw: { width: size.w, height: size.h, channels: 4 } });
  const even = (n: number, len: number) => Array.from({ length: n + 1 }, (_, i) => Math.round((i * len) / n));
  const xs = layout.edges?.xs ?? even(layout.cols, size.w);
  const ys = layout.edges?.ys ?? even(layout.rows, size.h);
  const composites: OverlayOptions[] = [];
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const cell = await src()
        .extract({ left: xs[c]!, top: ys[r]!, width: xs[c + 1]! - xs[c]!, height: ys[r + 1]! - ys[r]! })
        .resize(cellW, cellH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
        .png()
        .toBuffer();
      composites.push({ input: cell, left: c * cellW, top: r * cellH });
    }
  }
  return sharp({ create: { width: layout.cols * cellW, height: layout.rows * cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png()
    .toBuffer();
}

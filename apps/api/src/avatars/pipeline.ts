import { AVATAR_LIMITS, AVATAR_MAPPING, PET_FORMAT, RUNTIME_SHEET, type AvatarState, type AvatarValidationIssue } from '@spinroom/contracts';
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
}

/** FR-A3: detect the grid from dimensions. */
export function detectLayout(w: number, h: number, manual?: { cols?: number; rows?: number }): Layout {
  if (w === PET_FORMAT.v1.w && h === PET_FORMAT.v1.h) return { version: 1, cols: PET_FORMAT.cols, rows: PET_FORMAT.v1.rows };
  if (w === PET_FORMAT.v2.w && h === PET_FORMAT.v2.h) return { version: 2, cols: PET_FORMAT.cols, rows: PET_FORMAT.v2.rows };
  if (w % PET_FORMAT.cellW === 0 && h % PET_FORMAT.cellH === 0) {
    const cols = w / PET_FORMAT.cellW;
    const rows = h / PET_FORMAT.cellH;
    if (manual?.cols === cols && manual?.rows === rows) return { version: null, cols, rows };
    throw new AvatarImportError(
      'grid_unknown',
      `This sheet divides into ${cols} × ${rows} cells of 192 × 208 px, which isn’t a standard ChatGPT layout. Confirm the grid to continue.`,
      { needsGrid: { cols, rows }, detectedSize: { w, h } },
    );
  }
  throw new AvatarImportError(
    'size_unsupported',
    `This image is ${w} × ${h}. ChatGPT pet sheets are 1536 × 1872 or 1536 × 2288 — use Download sprite kit in ChatGPT.`,
    { detectedSize: { w, h } },
  );
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

export interface BuiltSheet {
  sheet: Buffer;
  thumb: Buffer;
  rows: { state: AvatarState; frames: number; dimmed?: boolean }[];
  frameCounts: Record<string, number>;
  issues: AvatarValidationIssue[];
  layout: Layout;
  size: { w: number; h: number };
}

/** FR-A2, A3, A5, A6, A18: validate a sheet and build the Spinroom runtime sheet + thumbnail. */
export async function buildRuntimeSheet(input: Buffer, manualGrid?: { cols?: number; rows?: number }): Promise<BuiltSheet> {
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
  const w = meta.width!;
  const h = meta.height!;
  const layout = detectLayout(w, h, manualGrid);
  const raw = await sharp(input).ensureAlpha().raw().toBuffer();
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
    if (frames > 0) plan.push({ state: m.state, srcRow: idx, frames });
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
  const maxFrames = Math.max(...plan.map((p) => p.frames));
  const composites: OverlayOptions[] = [];
  const cellCache = new Map<string, Buffer>();
  for (let r = 0; r < plan.length; r++) {
    const p = plan[r]!;
    for (let f = 0; f < p.frames; f++) {
      const key = `${p.srcRow}:${f}`;
      let cell = cellCache.get(key);
      if (!cell) {
        cell = await sharp(input)
          .extract({ left: f * PET_FORMAT.cellW, top: p.srcRow * PET_FORMAT.cellH, width: PET_FORMAT.cellW, height: PET_FORMAT.cellH })
          .resize(cw, ch, { kernel: 'lanczos3' })
          .png()
          .toBuffer();
        cellCache.set(key, cell);
      }
      composites.push({ input: cell, left: f * cw, top: r * ch });
    }
  }
  const canvas = sharp({ create: { width: maxFrames * cw, height: plan.length * ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(
    composites,
  );
  const flat = await canvas.png().toBuffer();
  let sheet: Buffer | null = null;
  for (const quality of [88, 80, 70, 60, 50]) {
    // Re-encoding through sharp drops all metadata (FR-A6).
    const out = await sharp(flat).webp({ quality, alphaQuality: 90, effort: 5 }).toBuffer();
    if (out.length <= RUNTIME_SHEET.maxBytes) {
      sheet = out;
      break;
    }
  }
  if (!sheet) throw new AvatarImportError('sheet_too_large', 'The converted sheet is over 150 KB even at low quality. Try a pet with fewer or simpler frames.');

  const firstIdle = cellCache.get(`${idleRow}:0`)!;
  const thumb = await sharp(firstIdle)
    .resize(RUNTIME_SHEET.thumbSize, RUNTIME_SHEET.thumbSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    sheet,
    thumb,
    rows: plan.map((p) => ({ state: p.state, frames: p.frames, ...(p.dimmed ? { dimmed: true } : {}) })),
    frameCounts,
    issues,
    layout,
    size: { w, h },
  };
}

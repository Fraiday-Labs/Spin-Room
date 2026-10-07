import mapping from './avatar-mapping.json' with { type: 'json' };
import type { AvatarState } from './models.js';

export interface AvatarMappingEntry {
  state: AvatarState;
  row: string;
  required?: boolean;
  fallback?: string;
  dimWhenFallback?: boolean;
}

export const AVATAR_MAPPING = mapping as { petRows: string[]; states: AvatarMappingEntry[] };

/** ChatGPT / Codex pet sheet format (community-documented). */
export const PET_FORMAT = {
  cellW: 192,
  cellH: 208,
  cols: 8,
  v1: { w: 1536, h: 1872, rows: 9 },
  v2: { w: 1536, h: 2288, rows: 11 },
} as const;

/** Spinroom runtime sheet format. */
export const RUNTIME_SHEET = {
  cellW: 96,
  cellH: 104,
  maxBytes: 150 * 1024,
  thumbSize: 128,
} as const;

export const AVATAR_LIMITS = {
  uploadMaxBytes: 10 * 1024 * 1024,
  zipExpandedMaxBytes: 20 * 1024 * 1024,
  petJsonMaxBytes: 64 * 1024,
  nameMaxLength: 32,
  customPerUser: 5,
} as const;

/** Original preset characters (front-facing). Art lives in apps/web/public/art/avatars. */
export const PRESET_AVATARS = [
  { id: 'preset-bolt', name: 'Bolt' },
  { id: 'preset-mochi', name: 'Mochi' },
  { id: 'preset-pix', name: 'Pix' },
  { id: 'preset-juno', name: 'Juno' },
  { id: 'preset-tako', name: 'Tako' },
  { id: 'preset-rue', name: 'Rue' },
] as const;
export const DEFAULT_PRESET_ID = 'preset-bolt';

/** Member colors (crowd tint) — drawn from the Pixel Neon DJ palette. */
export const AVATAR_COLORS = ['#3DE2FF', '#FF2BD6', '#FFB000', '#7A4DFF', '#FF4FA3', '#FFD24A', '#5B2DFF', '#8CF5C8'] as const;

/** Booth slot neon colors: cyan, magenta, amber. */
export const SLOT_COLORS = ['#3DE2FF', '#FF2BD6', '#FFB000'] as const;

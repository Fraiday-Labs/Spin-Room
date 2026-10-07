import sharp from 'sharp';

export type RGBA = [number, number, number, number];

export function hex(h: string, a = 255): RGBA {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

/** A tiny RGBA pixel canvas for authoring pixel art in code. No smoothing, ever. */
export class Canvas {
  readonly data: Buffer;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = Buffer.alloc(w * h * 4, 0);
  }

  set(x: number, y: number, c: RGBA | string, alpha?: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const col = typeof c === 'string' ? hex(c, alpha ?? 255) : alpha !== undefined ? ([c[0], c[1], c[2], alpha] as RGBA) : c;
    const i = (y * this.w + x) * 4;
    const a = col[3] / 255;
    if (a >= 1 || this.data[i + 3] === 0) {
      this.data[i] = col[0];
      this.data[i + 1] = col[1];
      this.data[i + 2] = col[2];
      this.data[i + 3] = col[3];
      return;
    }
    // Simple "over" compositing for translucent pixels (beams, glows).
    const da = this.data[i + 3]! / 255;
    const oa = a + da * (1 - a);
    for (let k = 0; k < 3; k++) this.data[i + k] = Math.round((col[k]! * a + this.data[i + k]! * da * (1 - a)) / oa);
    this.data[i + 3] = Math.round(oa * 255);
  }

  get(x: number, y: number): RGBA {
    const i = (y * this.w + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }

  rect(x: number, y: number, w: number, h: number, c: RGBA | string, alpha?: number) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c, alpha);
  }

  frame(x: number, y: number, w: number, h: number, c: RGBA | string) {
    this.rect(x, y, w, 1, c);
    this.rect(x, y + h - 1, w, 1, c);
    this.rect(x, y, 1, h, c);
    this.rect(x + w - 1, y, 1, h, c);
  }

  hline(x0: number, x1: number, y: number, c: RGBA | string, alpha?: number) {
    for (let x = x0; x <= x1; x++) this.set(x, y, c, alpha);
  }

  vline(x: number, y0: number, y1: number, c: RGBA | string, alpha?: number) {
    for (let y = y0; y <= y1; y++) this.set(x, y, c, alpha);
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGBA | string) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  disc(cx: number, cy: number, r: number, c: RGBA | string, alpha?: number) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) this.set(cx + x, cy + y, c, alpha);
  }

  ring(cx: number, cy: number, r: number, c: RGBA | string) {
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (d <= r * r + r * 0.6 && d >= (r - 1) * (r - 1) + (r - 1) * 0.6) this.set(cx + x, cy + y, c);
      }
  }

  /** Ordered 2×2 dither between two colors, `t` in 0..1 (no gradients — PRD scene rules). */
  dither(x: number, y: number, w: number, h: number, a: string, b: string, t: number) {
    const m = [0, 2, 3, 1];
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const th = (m[(yy % 2) * 2 + (xx % 2)]! + 0.5) / 4;
        this.set(xx, yy, t > th ? b : a);
      }
  }

  /** Paint another canvas onto this one. `mirror` flips horizontally. */
  blit(src: Canvas, dx: number, dy: number, opts: { mirror?: boolean; sx?: number; sy?: number; sw?: number; sh?: number } = {}) {
    const sx = opts.sx ?? 0;
    const sy = opts.sy ?? 0;
    const sw = opts.sw ?? src.w;
    const sh = opts.sh ?? src.h;
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const c = src.get(sx + (opts.mirror ? sw - 1 - x : x), sy + y);
        if (c[3]) this.set(dx + x, dy + y, c);
      }
  }

  /** Nearest-neighbour upscale by an integer factor. */
  scale(k: number): Canvas {
    const out = new Canvas(this.w * k, this.h * k);
    for (let y = 0; y < out.h; y++)
      for (let x = 0; x < out.w; x++) {
        const i = (Math.floor(y / k) * this.w + Math.floor(x / k)) * 4;
        const o = (y * out.w + x) * 4;
        this.data.copy(out.data, o, i, i + 4);
      }
    return out;
  }

  sharp() {
    return sharp(this.data, { raw: { width: this.w, height: this.h, channels: 4 } });
  }

  async webp(): Promise<Buffer> {
    return this.sharp().webp({ lossless: true, effort: 6 }).toBuffer();
  }

  async png(): Promise<Buffer> {
    return this.sharp().png({ compressionLevel: 9, palette: true, colours: 64 }).toBuffer();
  }
}

/** Deterministic PRNG so builds are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

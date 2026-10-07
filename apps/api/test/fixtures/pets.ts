import { zipSync } from 'fflate';
import sharp from 'sharp';

/** Generate ChatGPT-style pet sheets for tests: 192 × 208 cells, 8 columns. */
export async function makeSheet(opts: {
  w?: number;
  h?: number;
  rows?: number[];
  format?: 'png' | 'webp' | 'jpeg';
  alpha?: boolean;
}): Promise<Buffer> {
  const w = opts.w ?? 1536;
  const h = opts.h ?? 1872;
  const ch = opts.alpha === false ? 3 : 4;
  const raw = Buffer.alloc(w * h * ch, 0);
  const rows = opts.rows ?? [];
  rows.forEach((frames, r) => {
    for (let f = 0; f < frames; f++) {
      const x0 = f * 192 + 40;
      const y0 = r * 208 + 40;
      const color = [(r * 40) % 255, (f * 30) % 255, 200];
      for (let y = y0; y < y0 + 120 && y < h; y++) {
        for (let x = x0; x < x0 + 110 && x < w; x++) {
          const i = (y * w + x) * ch;
          raw[i] = color[0]!;
          raw[i + 1] = color[1]!;
          raw[i + 2] = color[2]!;
          if (ch === 4) raw[i + 3] = 255;
        }
      }
    }
  });
  const img = sharp(raw, { raw: { width: w, height: h, channels: ch as 3 | 4 } });
  if (opts.format === 'webp') return img.webp({ lossless: true }).toBuffer();
  if (opts.format === 'jpeg') return img.jpeg().toBuffer();
  return img.png().toBuffer();
}

export function makeKit(files: Record<string, Buffer | string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v);
  return Buffer.from(zipSync(entries));
}

export function multipart(files: { field?: string; filename: string; data: Buffer; type?: string }[]) {
  const boundary = `----spinroom${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'file'}"; filename="${f.filename}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`),
    );
    chunks.push(f.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Standard v1 rows: idle 8, running-right 6, running-left 6, waving 4, jumping 5, failed 3, waiting 2, running 6, review 0. */
export const V1_ROWS = [8, 6, 6, 4, 5, 3, 2, 6, 0];

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** S3-compatible object storage, content-addressed. A filesystem driver is used in dev. */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  /** Public URL (CDN in production) for a key. */
  url(key: string): string;
}

export class FsStorage implements Storage {
  private readonly root: string;
  constructor(
    dir: string,
    private readonly baseUrl: string,
  ) {
    this.root = resolve(dir);
  }
  private path(key: string) {
    if (key.includes('..') || key.startsWith('/')) throw new Error('bad key');
    return join(this.root, key);
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
  async exists(key: string) {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
  url(key: string) {
    return `${this.baseUrl}/${key}`;
  }
}

/**
 * Minimal S3 driver using SigV4 via fetch, so no AWS SDK is needed.
 * Works with AWS S3, Cloudflare R2, MinIO and other S3-compatible stores.
 */
export class S3Storage implements Storage {
  constructor(private readonly o: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string }) {}

  private async signed(method: string, key: string, body?: Buffer, contentType?: string): Promise<Response> {
    const { createHash, createHmac } = await import('node:crypto');
    const url = new URL(`${this.o.endpoint.replace(/\/$/, '')}/${this.o.bucket}/${key}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256')
      .update(body ?? '')
      .digest('hex');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(method === 'PUT' ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}),
    };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonical = [
      method,
      url.pathname,
      '',
      ...Object.keys(headers)
        .sort()
        .map((h) => `${h}:${headers[h]}`),
      '',
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${date}/${this.o.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
    const kSig = h(h(h(h(`AWS4${this.o.secretAccessKey}`, date), this.o.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSig).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers.host;
    return fetch(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
  }

  async put(key: string, data: Buffer, contentType: string) {
    const res = await this.signed('PUT', key, data, contentType);
    if (!res.ok) throw new Error(`S3 put ${key} failed: ${res.status}`);
  }
  async get(key: string) {
    const res = await this.signed('GET', key);
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }
  async exists(key: string) {
    return (await this.signed('HEAD', key)).ok;
  }
  url(key: string) {
    return `${this.o.publicBaseUrl}/${key}`;
  }
}

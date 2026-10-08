import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** Signs the Slack card's "Join room" link: lets members of a linked channel into the room. */
export function slackJoinSignature(secret: string, p: { teamId: string; channelId: string; roomId: string }): string {
  return hmac(secret, `slackjoin|${p.teamId}|${p.channelId}|${p.roomId}`);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Seals secrets at rest. Swap for a KMS-backed implementation in production if preferred. */
export interface Sealer {
  seal(plain: string): string;
  open(sealed: string): string;
}

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
/**
 * The 32-byte AES key from ENCRYPTION_KEY: base64 of exactly 32 bytes (`openssl rand -base64 32`),
 * or any other secret of 32+ characters (e.g. a host's "Generate" button), hashed with SHA-256.
 */
export function encryptionKey(secret: string): Buffer {
  const decoded = Buffer.from(secret, 'base64');
  if (decoded.length === 32 && decoded.toString('base64') === secret) return decoded;
  if (secret.length >= 32) return createHash('sha256').update(secret, 'utf8').digest();
  throw new Error('ENCRYPTION_KEY must be base64 of 32 bytes or a random secret of at least 32 characters');
}

export function createAesSealer(keySecret: string): Sealer {
  const key = encryptionKey(keySecret);
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    open(sealed) {
      const [v, iv, tag, ct] = sealed.split('.');
      if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad sealed value');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

/** PKCE helpers (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

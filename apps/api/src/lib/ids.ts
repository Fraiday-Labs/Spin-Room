import { uuidv7 } from 'uuidv7';
import { randomBytes } from 'node:crypto';

export const newId = (): string => uuidv7();

/** URL-safe random token with a readable prefix, e.g. `srp_…`, `inv_…`. */
export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

/** Short human code like `K7QX-29MD` for one-time link codes. */
export function humanCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[b[i]! % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

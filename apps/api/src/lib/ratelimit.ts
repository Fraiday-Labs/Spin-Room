import type { Redis } from 'ioredis';

/** Fixed-window counter. Returns ms until reset when over the limit, else 0. */
export async function hitRateLimit(redis: Redis, key: string, limit: number, windowMs: number, now = Date.now()): Promise<number> {
  const window = Math.floor(now / windowMs);
  const k = `rl:${key}:${window}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.pexpire(k, windowMs + 1000);
  return n > limit ? (window + 1) * windowMs - now : 0;
}

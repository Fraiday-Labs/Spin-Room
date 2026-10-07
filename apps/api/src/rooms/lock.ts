import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { SpinroomError } from '@spinroom/contracts';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Single writer per room across instances (PRD: room engine is single-writer per room via a
 * Redis lock). Calls within one process are also chained so they never spin on the lock.
 */
export class RoomLocks {
  private chains = new Map<string, Promise<unknown>>();
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs = 10_000,
    private readonly waitMs = 8_000,
  ) {}

  async with<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.acquired(roomId, fn));
    this.chains.set(roomId, run);
    try {
      return await run;
    } finally {
      if (this.chains.get(roomId) === run) this.chains.delete(roomId);
    }
  }

  private async acquired<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const key = `room:${roomId}:lock`;
    const token = randomBytes(12).toString('hex');
    const deadline = Date.now() + this.waitMs;
    let delay = 10;
    while (!(await this.redis.set(key, token, 'PX', this.ttlMs, 'NX'))) {
      if (Date.now() > deadline) throw new SpinroomError('conflict', 'Room is busy — try again');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 100);
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE, 1, key, token);
    }
  }
}

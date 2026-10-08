import { Redis } from 'ioredis';

export function createRedis(url: string): Redis {
  const r = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  // ioredis reconnects (and resubscribes) on its own; log drops instead of an unhandled-error trace.
  r.on('error', (e: Error) => console.warn(`[redis] ${e.message}`));
  return r;
}
export type { Redis };

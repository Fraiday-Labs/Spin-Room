import type { FastifyInstance } from 'fastify';

const MAX_PER_MINUTE = 20;
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);

/**
 * `POST /v1/client-errors`: the web app reports crashes it caught (error boundaries and
 * uncaught errors) so they show up in the server log. Write-only, size-capped and rate
 * limited per IP; nothing is stored.
 */
export function registerClientErrors(app: FastifyInstance) {
  const seen = new Map<string, { n: number; until: number }>();
  app.post('/v1/client-errors', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const now = Date.now();
    const hit = seen.get(req.ip);
    if (hit && hit.until > now && hit.n >= MAX_PER_MINUTE) return reply.code(429).send();
    if (!hit || hit.until <= now) seen.set(req.ip, { n: 1, until: now + 60_000 });
    else hit.n++;
    if (seen.size > 5000) for (const [ip, v] of seen) if (v.until <= now) seen.delete(ip);

    const b = (req.body ?? {}) as Record<string, unknown>;
    req.log.warn(
      {
        clientError: {
          message: clip(b.message, 500),
          stack: clip(b.stack, 4000),
          componentStack: clip(b.componentStack, 4000),
          where: clip(b.where, 100),
          url: clip(b.url, 300),
          release: clip(b.release, 60),
          userAgent: clip(req.headers['user-agent'], 300),
        },
      },
      'client error',
    );
    return reply.code(204).send();
  });
}

import {
  SpinroomError,
  routes,
  toFastifyPath,
  type RouteName,
  type RouteResponse,
  type Routes,
} from '@spinroom/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { hitRateLimit } from '../lib/ratelimit.js';
import { authenticate, authenticateService, checkCsrf, type AuthInfo, type ServiceName } from './auth.js';

export interface HandlerCtx<N extends RouteName> {
  name: N;
  params: z.output<Routes[N]['params']>;
  query: z.output<Routes[N]['query']>;
  body: z.output<Routes[N]['body']>;
  /** Present for user/admin routes; optional for `optional`. */
  auth: AuthInfo | null;
  service: ServiceName | null;
  req: FastifyRequest;
  reply: FastifyReply;
  ctx: AppContext;
}

/** Signed-in caller or throw. */
export function requireUser(c: { auth: AuthInfo | null }): AuthInfo {
  if (!c.auth) throw new SpinroomError('unauthenticated', 'Sign in required');
  return c.auth;
}

export type Handler<N extends RouteName> = (c: HandlerCtx<N>) => Promise<RouteResponse<N> | typeof REPLIED>;
export type Handlers = { [N in RouteName]?: Handler<N> };

/** Return this from a handler that already sent the reply (redirects, files). */
export const REPLIED: unique symbol = Symbol('replied');

const RATE = {
  /** General per-user write limit. */
  userWrites: { limit: 60, windowMs: 60_000 },
  /** MCP/agent writes (PRD: 20 per minute per user). */
  mcpWrites: { limit: 20, windowMs: 60_000 },
  /** Per-IP write limit. */
  ipWrites: { limit: 300, windowMs: 60_000 },
};

function parse<T extends z.ZodType>(schema: T, value: unknown, where: string): z.output<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new SpinroomError('validation_failed', `Invalid ${where}: ${r.error.issues.map((i) => `${i.path.join('.') || where} ${i.message}`).join('; ')}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext, handlers: Handlers) {
  for (const [name, handler] of Object.entries(handlers) as [RouteName, Handler<RouteName>][]) {
    const def = routes[name];
    app.route({
      method: def.method,
      url: toFastifyPath(def.path),
      handler: async (req, reply) => {
        let auth: AuthInfo | null = null;
        let service: ServiceName | null = null;
        if (def.auth === 'service') {
          service = authenticateService(ctx, req);
          if (!service) throw new SpinroomError('unauthenticated', 'Service credential required');
        } else if (def.auth !== 'none') {
          auth = await authenticate(ctx, req).catch((e) => {
            if (def.auth === 'optional') return null;
            throw e;
          });
          if (!auth && def.auth !== 'optional') throw new SpinroomError('unauthenticated', 'Sign in required');
          if (def.auth === 'admin') {
            const u = await ctx.services.users.get(auth!.userId);
            if (!u?.isAdmin) throw new SpinroomError('forbidden', 'Admins only');
          }
        }

        if (def.write) {
          if (auth?.via === 'cookie') checkCsrf(req);
          const ipWait = await hitRateLimit(ctx.redis, `ip:${req.ip}`, RATE.ipWrites.limit, RATE.ipWrites.windowMs, ctx.clock.now());
          const r = auth?.surface === 'mcp' ? RATE.mcpWrites : RATE.userWrites;
          const userWait = auth ? await hitRateLimit(ctx.redis, `u:${auth.userId}:${auth.surface === 'mcp' ? 'mcp' : 'w'}`, r.limit, r.windowMs, ctx.clock.now()) : 0;
          const wait = Math.max(ipWait, userWait);
          if (wait > 0) {
            reply.header('retry-after', Math.ceil(wait / 1000));
            throw new SpinroomError('rate_limited', 'Too many requests — slow down', { retryAfterMs: wait });
          }
        }

        const idemKey = def.write && auth ? req.headers['idempotency-key'] : undefined;
        const idemRedisKey = typeof idemKey === 'string' && idemKey ? `idem:${auth!.userId}:${name}:${idemKey.slice(0, 128)}` : null;
        if (idemRedisKey) {
          const cached = await ctx.redis.get(idemRedisKey);
          if (cached === 'pending') throw new SpinroomError('conflict', 'A request with this Idempotency-Key is in progress');
          if (cached) {
            const { status, body } = JSON.parse(cached) as { status: number; body: unknown };
            reply.header('idempotent-replay', 'true');
            return reply.code(status).send(body);
          }
          await ctx.redis.set(idemRedisKey, 'pending', 'EX', 60, 'NX');
        }

        try {
          const c: HandlerCtx<RouteName> = {
            name,
            params: parse(def.params, req.params, 'path'),
            query: parse(def.query, req.query, 'query'),
            body: def.kind === 'multipart' || def.method === 'GET' ? ({} as never) : parse(def.body, req.body, 'body'),
            auth,
            service,
            req,
            reply,
            ctx,
          };
          const out = await handler(c);
          if (out === REPLIED) return reply;
          // Contract enforcement: outside production every response is checked against its schema.
          const body = ctx.cfg.NODE_ENV === 'production' ? out : def.response.parse(out);
          if (idemRedisKey) await ctx.redis.set(idemRedisKey, JSON.stringify({ status: 200, body }), 'EX', 86_400);
          return reply.send(body);
        } catch (e) {
          if (idemRedisKey) await ctx.redis.del(idemRedisKey);
          throw e;
        }
      },
    });
  }
}

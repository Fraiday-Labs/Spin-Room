import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fakeCoverSvg } from '../spotify/fake.js';

/** Content-addressed blobs (avatars) in dev, and fake album covers in fake mode. */
export function registerAssetRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { '*': string } }>('/v1/assets/*', async (req, reply) => {
    const key = req.params['*'];
    if (!/^[a-z0-9/_.-]+$/i.test(key) || key.includes('..')) return reply.code(404).send();
    const data = await ctx.storage.get(key);
    if (!data) return reply.code(404).send();
    const type = key.endsWith('.webp') ? 'image/webp' : key.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    return reply.header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').type(type).send(data);
  });
  if (ctx.spotify.mode === 'fake') {
    app.get<{ Params: { id: string } }>('/v1/fake-spotify/cover/:id', async (req, reply) => {
      const id = req.params.id.replace(/\.svg$/, '');
      return reply.header('cache-control', 'public, max-age=86400').type('image/svg+xml').send(fakeCoverSvg(id));
    });
  }
}

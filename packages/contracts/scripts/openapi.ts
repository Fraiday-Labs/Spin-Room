import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ProblemSchema, routes } from '../src/index.js';

/** Generate OpenAPI 3.1 from the Zod route registry — the single source of truth. */
const paths: Record<string, Record<string, unknown>> = {};
const toSchema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });

for (const [name, r] of Object.entries(routes)) {
  const params = Object.keys((r.params as z.ZodObject).shape ?? {}).map((p) => ({ name: p, in: 'path', required: true, schema: { type: 'string' } }));
  const qShape = (r.query as z.ZodObject).shape ?? {};
  const query = Object.entries(qShape).map(([p, s]) => ({ name: p, in: 'query', required: false, schema: toSchema(s as z.ZodType) }));
  const op: Record<string, unknown> = {
    operationId: name,
    summary: r.summary,
    parameters: [...params, ...query],
    responses: {
      [r.kind === 'redirect' ? '302' : '200']: r.kind === 'redirect' ? { description: 'Redirect' } : { description: 'OK', content: { 'application/json': { schema: toSchema(r.response) } } },
      default: { description: 'Problem', content: { 'application/problem+json': { schema: toSchema(ProblemSchema) } } },
    },
    security: r.auth === 'none' ? [] : [{ bearer: [] }, { cookie: [] }],
  };
  if (r.method !== 'GET' && Object.keys((r.body as z.ZodObject).shape ?? { x: 1 }).length) {
    op.requestBody = r.kind === 'multipart' ? { content: { 'multipart/form-data': { schema: { type: 'object' } } } } : { content: { 'application/json': { schema: toSchema(r.body) } } };
  }
  (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
}

const doc = {
  openapi: '3.1.0',
  info: { title: 'Spinroom API', version: '1.0.0', description: 'One API for the web app, MCP server, Slack app and future native clients.' },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
      cookie: { type: 'apiKey', in: 'cookie', name: 'sr_at' },
    },
  },
  paths,
};
const out = fileURLToPath(new URL('../openapi.json', import.meta.url));
writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`wrote ${out} (${Object.keys(routes).length} operations)`);

import { routes, toFastifyPath } from '@spinroom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => t?.close());

describe('contract coverage', () => {
  it('implements every route in the contracts registry (one API for every client)', async () => {
    t = await createTestApp();
    const missing = Object.entries(routes)
      .filter(([, r]) => !t.app.hasRoute({ method: r.method, url: toFastifyPath(r.path) }))
      .map(([name, r]) => `${name} ${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('serves the realtime socket and OAuth metadata', async () => {
    t = await createTestApp();
    expect(t.app.hasRoute({ method: 'GET', url: '/v1/rooms/:slug/live' })).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json().code_challenge_methods_supported).toEqual(['S256']);
  });
});

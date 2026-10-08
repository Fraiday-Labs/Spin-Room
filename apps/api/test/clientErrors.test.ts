import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

let t: TestApp;
afterEach(async () => t?.close());

describe('client error reports', () => {
  it('accepts a report without sign-in, then rate limits', async () => {
    t = await createTestApp();
    const send = () =>
      t.app.inject({ method: 'POST', url: '/v1/client-errors', payload: { message: 'boom', stack: 'at Rail', where: 'rail:chat', url: '/r/test-1' } });
    expect((await send()).statusCode).toBe(204);
    for (let i = 0; i < 19; i++) await send();
    expect((await send()).statusCode).toBe(429);
  });

  it('refuses oversized reports', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'POST', url: '/v1/client-errors', payload: { message: 'x'.repeat(20_000) } });
    expect(res.statusCode).toBe(413);
  });
});

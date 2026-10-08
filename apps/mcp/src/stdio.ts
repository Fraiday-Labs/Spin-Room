#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SpinroomClient, type WsLike } from '@spinroom/sdk';
import WebSocket from 'ws';
import { createSpinroomServer } from './tools.js';

/**
 * `npx spinroom-mcp` — stdio MCP server for clients without remote MCP/OAuth.
 *   npx spinroom-mcp login <CODE>   one-time code from Integrations → Local server
 *   SPINROOM_TOKEN=srp_…            or set a personal access token
 *   SPINROOM_URL=https://…          your Spinroom origin
 */
const baseUrl = (process.env.SPINROOM_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const tokenFile = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'spinroom', 'token');

async function storedToken(): Promise<string | null> {
  try {
    return (await readFile(tokenFile, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'login') {
    if (!arg) throw new Error('Usage: spinroom-mcp login <CODE>');
    const anon = new SpinroomClient({ baseUrl });
    const r = await anon.call('linkCodes.redeem', { body: { code: arg, label: 'spinroom-mcp (stdio)' } });
    await mkdir(join(tokenFile, '..'), { recursive: true });
    await writeFile(tokenFile, r.token);
    await chmod(tokenFile, 0o600);
    console.error(`Signed in as ${r.displayName}. Token saved to ${tokenFile}.`);
    return;
  }
  const token = process.env.SPINROOM_TOKEN ?? (await storedToken());
  if (!token) {
    console.error('No Spinroom token. Run `npx spinroom-mcp login <CODE>` (code from Integrations → Local server) or set SPINROOM_TOKEN.');
    process.exit(1);
  }
  const client = new SpinroomClient({ baseUrl, surface: 'mcp', getToken: () => token });
  const { server } = createSpinroomServer({
    client,
    publicUrl: baseUrl,
    connectLive: (u) => new WebSocket(u, { headers: { authorization: `Bearer ${token}` } }) as unknown as WsLike,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

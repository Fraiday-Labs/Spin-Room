import { mcpConfig } from './config.js';
import { createMcpHttpServer } from './remote.js';

/** Entry point of the standalone remote MCP server (its own port). */
const cfg = mcpConfig();
const { server } = createMcpHttpServer(cfg);
server.listen(cfg.port, cfg.host, () => console.log(`Spinroom MCP on http://${cfg.host}:${cfg.port}/mcp (resource ${cfg.resourceUrl})`));

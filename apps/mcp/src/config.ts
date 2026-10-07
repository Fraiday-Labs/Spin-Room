export function mcpConfig(raw: Record<string, string | undefined> = process.env) {
  const env = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ''));
  const apiUrl = (env.SPINROOM_API_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
  return {
    apiUrl,
    /** Web origin used in speaker and invite links. */
    publicUrl: (env.SPINROOM_PUBLIC_URL ?? env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173').replace(/\/$/, ''),
    port: Number(env.MCP_PORT ?? 8090),
    host: env.MCP_HOST ?? '0.0.0.0',
    resourceUrl: env.MCP_RESOURCE_URL ?? 'http://127.0.0.1:8090/mcp',
    /** Authorization server (the API's public origin). */
    issuer: (env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173').replace(/\/$/, ''),
    serviceSecret: env.SERVICE_SECRET_MCP ?? 'dev-mcp-service-secret',
  };
}
export type McpConfig = ReturnType<typeof mcpConfig>;

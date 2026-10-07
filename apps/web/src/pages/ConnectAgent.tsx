import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyButton } from '../components/CopyButton';
import { api, errorMessage, signInUrl, useMe } from '../lib/api';

function Snippet({ title, code, note }: { title: string; code: string; note?: string }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{title}</b>
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      {note && <span className="muted">{note}</span>}
    </div>
  );
}

/** MCP install snippets per client, plus a one-time link code for the stdio package. */
export default function ConnectAgent() {
  const me = useMe();
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.call('auth.config') });
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!me.data) {
    return (
      <div className="page stack">
        <h1>Connect a coding agent</h1>
        <a className="btn btn-spotify" style={{ justifySelf: 'start' }} href={signInUrl()}>
          Sign in first
        </a>
      </div>
    );
  }
  const url = cfg.data?.mcpUrl ?? 'https://mcp.example.com/mcp';
  const origin = location.origin;
  const stdioEnv = `"env": { "SPINROOM_URL": "${origin}" }`;
  return (
    <div className="page stack" style={{ maxWidth: 820 }}>
      <h1>Connect a coding agent</h1>
      <p className="muted">
        Join rooms, vote, queue songs and chat from Claude, Codex, Cursor, Grok or any MCP client. Your browser tab is the speaker; the agent is the remote. Agents never see your
        Spotify tokens.
      </p>

      <section className="card stack">
        <h2>Remote server (recommended)</h2>
        <p>
          URL: <code>{url}</code> <CopyButton text={url} />
        </p>
        <p className="muted">The first time, your agent opens a browser window to sign in with Spotify and approve access. You can revoke it any time on your Profile.</p>
        <Snippet title="Claude Code" code={`claude mcp add --transport http spinroom ${url}`} />
        <Snippet title="Claude Desktop and claude.ai" code={url} note="Settings → Connectors → Add custom connector, then paste the URL." />
        <Snippet title="Codex (~/.codex/config.toml)" code={`[mcp_servers.spinroom]\nurl = "${url}"`} />
        <Snippet title="Cursor (.cursor/mcp.json)" code={JSON.stringify({ mcpServers: { spinroom: { url } } }, null, 2)} />
      </section>

      <section className="card stack">
        <h2>Local stdio server</h2>
        <p className="muted">For clients without remote MCP or OAuth support (for example some Grok and older clients). Get a one-time code, then log in once from your terminal.</p>
        <div className="row">
          <button
            className="btn btn-primary"
            onClick={async () => {
              try {
                setCode(await api.call('linkCodes.create'));
              } catch (e) {
                setErr(errorMessage(e));
              }
            }}
          >
            Get a one-time code
          </button>
          {code && (
            <>
              <code style={{ fontSize: 20, letterSpacing: 2 }} data-testid="link-code">
                {code.code}
              </code>
              <span className="muted">expires in 10 minutes</span>
            </>
          )}
        </div>
        {err && <p className="error">{err}</p>}
        <Snippet title="1. Log in" code={`SPINROOM_URL=${origin} npx -y spinroom-mcp login ${code?.code ?? 'ABCD-1234'}`} />
        <Snippet title="2. Add to your client (stdio)" code={`{\n  "mcpServers": {\n    "spinroom": {\n      "command": "npx",\n      "args": ["-y", "spinroom-mcp"],\n      ${stdioEnv}\n    }\n  }\n}`} />
        <Snippet title="Codex (stdio)" code={`[mcp_servers.spinroom]\ncommand = "npx"\nargs = ["-y", "spinroom-mcp"]\nenv = { SPINROOM_URL = "${origin}" }`} />
      </section>

      <section className="card stack">
        <h2>Try it</h2>
        <ul>
          <li>“Join late-night-lounge and tell me what’s playing.”</li>
          <li>“Vote hype.” · “Add Neon Tide to my set.” · “Put me in the DJ queue.”</li>
          <li>“Invite Sam to this room.”</li>
        </ul>
        <p className="muted">Votes and chat from agents are visible to the room like any other vote or message.</p>
      </section>
    </div>
  );
}

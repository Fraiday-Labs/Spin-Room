import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'wouter';
import type { Me } from '@spinroom/contracts';
import { CopyButton } from '../components/CopyButton';
import { api, errorMessage } from '../lib/api';
import s from './Integrations.module.css';

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

type Tab = 'remote' | 'local' | 'slack';
const TABS: [Tab, string][] = [
  ['remote', 'Remote server'],
  ['local', 'Local server'],
  ['slack', 'Slack'],
];

const TRY_IT = (
  <section className="card stack">
    <h2>Try it</h2>
    <ul>
      <li>“Join late-night-lounge and tell me what’s playing.”</li>
      <li>“Vote hype.” · “Add Neon Tide to my set.” · “Put me in the DJ queue.”</li>
      <li>“Invite Sam to this room.”</li>
    </ul>
    <p className="muted">Votes and chat from agents are visible to the room like any other vote or message.</p>
  </section>
);

/** Profile → Integrations: MCP (remote and local stdio servers) and Slack, one sub-tab each. */
export function IntegrationsPanel({ me, sub }: { me: Me; sub?: string }) {
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api.call('auth.config') });
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tab: Tab = TABS.some(([id]) => id === sub) ? (sub as Tab) : 'remote';
  const url = cfg.data?.mcpUrl ?? 'https://mcp.example.com/mcp';
  const origin = location.origin;
  const stdioEnv = `"env": { "SPINROOM_URL": "${origin}" }`;
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Use Spinroom from your coding agent or from Slack: join rooms, vote, queue songs and chat. Your browser tab stays the speaker. Integrations never see
        your Spotify tokens.
      </p>

      <nav className={s.subtabs} role="tablist" aria-label="Integrations">
        {TABS.map(([id, label]) => (
          <Link
            key={id}
            href={`/profile/integrations/${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`integration-${id}`}
            className={`${s.subtab} ${tab === id ? s.active : ''}`}
          >
            {label}
          </Link>
        ))}
      </nav>

      <div role="tabpanel" id={`integration-${tab}`} className="stack">
        {tab === 'remote' && (
          <>
            <section className="card stack">
              <h2>Remote MCP server (recommended)</h2>
              <p>
                URL: <code>{url}</code> <CopyButton text={url} />
              </p>
              <p className="muted">
                The first time, your agent opens a browser window to sign in with Spotify and approve access. You can revoke it any time on your Profile.
              </p>
              <Snippet title="Claude Code" code={`claude mcp add --transport http spinroom ${url}`} />
              <Snippet title="Claude Desktop and claude.ai" code={url} note="Settings → Connectors → Add custom connector, then paste the URL." />
              <Snippet title="Codex (~/.codex/config.toml)" code={`[mcp_servers.spinroom]\nurl = "${url}"`} />
              <Snippet title="Cursor (.cursor/mcp.json)" code={JSON.stringify({ mcpServers: { spinroom: { url } } }, null, 2)} />
            </section>
            {TRY_IT}
          </>
        )}

        {tab === 'local' && (
          <>
            <section className="card stack">
              <h2>Local MCP server (stdio)</h2>
              <p className="muted">
                For clients without remote MCP or OAuth support (for example some Grok and older clients). Get a one-time code, then log in once from your
                terminal.
              </p>
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
              <Snippet
                title="2. Add to your client (stdio)"
                code={`{\n  "mcpServers": {\n    "spinroom": {\n      "command": "npx",\n      "args": ["-y", "spinroom-mcp"],\n      ${stdioEnv}\n    }\n  }\n}`}
              />
              <Snippet
                title="Codex (stdio)"
                code={`[mcp_servers.spinroom]\ncommand = "npx"\nargs = ["-y", "spinroom-mcp"]\nenv = { SPINROOM_URL = "${origin}" }`}
              />
            </section>
            {TRY_IT}
          </>
        )}

        {tab === 'slack' && <SlackTab connected={me.connections.slack} installUrl={cfg.data?.slackInstallUrl ?? null} />}
      </div>
    </div>
  );
}

const SLACK_COMMANDS: [string, string][] = [
  ['/spinroom link <room>', 'Link a channel to a room (room owners and moderators). The channel gets a live now-playing card.'],
  ['/spinroom now', 'Show what’s playing, just to you'],
  ['/spinroom hype · /spinroom skip', 'Vote on the current song'],
  ['/spinroom add <search>', 'Add a song to your set'],
  ['/spinroom dj · /spinroom undj', 'Join or leave the DJ queue'],
  ['/spinroom invite @someone', 'DM a teammate an invite link'],
  ['/spinroom button [room]', 'Post a “Join room” button for the channel: one click takes people into the room'],
  ['/spinroom speaker', 'DM yourself the speaker link (listening happens in a browser tab)'],
  ['/spinroom recap', 'Post this week’s recap now: DJ of the week and the most-hyped songs (it also posts itself on Fridays at 4 pm)'],
  ['/spinroom moments on|off · recap on|off', 'Thread updates under the card (new DJ, big hype, crowd skip) and the Friday recap — owners and moderators'],
];

/** Slack: what it does, workspace install, and this account's link status. */
function SlackTab({ connected, installUrl }: { connected: boolean; installUrl: string | null }) {
  return (
    <>
      <section className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Slack</h2>
          <span className={connected ? 'badge badge-ok' : 'badge'}>{connected ? 'Your Slack account is linked' : 'Not linked yet'}</span>
        </div>
        <p className="muted">
          Bring a room into a Slack channel: a live card shows what’s playing, and everyone can vote, queue songs and grab invites without leaving Slack.
        </p>
        {installUrl ? (
          <div className="stack" style={{ gap: 6 }}>
            <a className="btn btn-primary" style={{ justifySelf: 'start' }} href={installUrl} data-testid="slack-install">
              Add Spinroom to Slack
            </a>
            <span className="muted">
              A workspace admin may need to approve it. Then run <code>/spinroom</code> in any channel; the first time, Slack asks you to connect your Spinroom
              account.
            </span>
          </div>
        ) : (
          <div className="notice" data-testid="slack-not-configured">
            Slack isn’t set up on this Spinroom server yet. Once the server admin adds the Slack app’s credentials, an <b>Add Spinroom to Slack</b> button
            appears here.
          </div>
        )}
      </section>
      <section className="card stack">
        <h2>Commands</h2>
        <dl className="stack" style={{ gap: 8, margin: 0 }}>
          {SLACK_COMMANDS.map(([cmd, what]) => (
            <div key={cmd}>
              <dt>
                <code>{cmd}</code>
              </dt>
              <dd className="muted" style={{ margin: '2px 0 0' }}>
                {what}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

# Spinroom

Social DJ rooms on Spotify. Friends gather in a tiny pixel nightclub, take turns DJing from their Spotify playlists, and vote each track **Hype** or **Skip**. Spinroom never streams audio: every listener plays the same track at the same position on their own Spotify Premium account, in a browser **speaker** tab. Spinroom owns the room, the rotation, the votes and the sync.

The same room is reachable from three surfaces on one API:

- **Web app**: the visual room and the speaker.
- **MCP server**: join, vote, queue songs and chat from Claude, Codex, Cursor, Grok or any MCP client.
- **Slack app**: a live now-playing card with voting and queue controls.

![The room: Pixel Neon DJ stage, Spotify player panel and DJ queue](docs/images/room.png)

<p align="center"><img src="docs/images/room-mobile.png" width="260" alt="The room on a phone"> &nbsp; <img src="docs/images/lobby.png" width="460" alt="Lobby with room creation and avatar picker"></p>

The product spec is [docs/PRD.md](docs/PRD.md), the build plan is [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md), and the scene design system is [docs/design/pixel-neon-dj.md](docs/design/pixel-neon-dj.md).

---

## Architecture

```
            ┌──────────── one public origin (web + /v1) ─────────────┐
 browser ──▶│  apps/web (Vite/React SPA, speaker tab)                │
            │      │  /v1 REST + WebSocket /v1/rooms/{slug}/live      │
            │      ▼                                                  │
            │  apps/api (Fastify) ── room runtime ── packages/room-engine (pure rules)
            │      │        │                                         │
            │   Postgres   Redis (state, single-writer lock, pub/sub events)
            └──────────────────────────┬──────────────────────────────┘
                                       │ events:room:*  + token exchange
           apps/mcp (MCP over HTTP+OAuth / stdio) ┘└ apps/slack (Bolt, HTTP mode)
```

| Path                   | What it is                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts`   | Zod schemas for every REST route, WebSocket event, error code and room setting. `openapi.json` is generated from them.                                       |
| `packages/room-engine` | Pure TypeScript rules: rotation, voting, auto-skip, bounce, presence, pause. It has no I/O and is fully unit-tested, including a 50-bot simulation.          |
| `packages/sdk`         | Typed REST client, live-room socket (seq-gap resync, 1–30 s backoff), server clock and drift controller. Used by web, MCP and Slack.                         |
| `packages/db`          | Drizzle schema, Postgres client and AES-GCM sealer shared by the API and Slack services.                                                                     |
| `apps/api`             | Auth (Spotify PKCE with your own Client ID), rooms, sets, votes, chat, moderation, speakers, avatars, the OAuth 2.1 server for MCP, and the realtime socket. |
| `apps/web`             | Lobby, room (stage, player panel, rail), speaker, avatar studio, settings, Connect agent, OAuth consent.                                                     |
| `apps/mcp`             | `spinroom-mcp`: 17 tools, a now-playing resource with subscriptions, and the `spinroom_session` prompt.                                                      |
| `apps/slack`           | Install, account linking, `/spinroom` commands, live card, buttons, modal.                                                                                   |
| `tools/art`            | All built-in pixel art, generated in code (`pnpm art`).                                                                                                      |

Key guarantees:

- **Server-authoritative sync.** Each spin has a `startedAtServerMs`. Speakers play at `now + offset − startedAtServerMs`, using the median of the last 5 clock samples. They check drift every 5 s, seek when it exceeds 500 ms, and reload after two checks over 3 s. The server owns track transitions: a timer fires at the end plus a 2 s grace, with a tick safety net behind it.
- **Single writer per room.** Commands run under a Redis lock. State lives in Redis and is rebuilt from Postgres on loss. Timers are rescheduled after restarts.
- **One API.** Every client uses the same `/v1` endpoints. A contract test fails if any registry route is missing, and responses are validated against their schemas outside production.

## Quick start (fake Spotify, no accounts needed)

Prerequisites: Node 22, pnpm 10, Postgres 16 and Redis 7 (`docker compose up -d` starts them, or use local installs).

```bash
pnpm install
cp .env.example .env                      # defaults run in SPOTIFY_MODE=fake
pnpm db:migrate && pnpm seed              # 3 fake users, 2 rooms
pnpm --filter @spinroom/api dev           # API on :8080
pnpm --filter @spinroom/web dev           # web on http://127.0.0.1:5173 (proxies /v1 to the API)
```

Open <http://127.0.0.1:5173>, click **Sign in with Spotify → Continue to test sign-in**, and pick `alice`. Open a second browser profile as `bob`. In the room, click **Start speaker**, add tracks under **My set**, and press **Q** to step up to the booth. Fake mode uses a fictional catalog and a silent simulated player, so sync, votes and rotation all work without audio.

Optional services:

```bash
pnpm --filter spinroom-mcp dev            # remote MCP on :8090/mcp
pnpm --filter @spinroom/slack dev         # Slack app on :8070
```

## Real Spotify (bring your own Client ID)

Spotify caps development-mode apps at 5 users, and extended quota requires 250,000 MAU. So Spinroom is built for **option B**: each user creates a free Spotify developer app and pastes its Client ID. Login is PKCE, so no client secret is ever stored.

1. Set `SPOTIFY_MODE=real` and `PUBLIC_ORIGIN` to your origin. Locally, use `http://127.0.0.1:5173`: Spotify requires loopback redirect URIs to use `127.0.0.1`, not `localhost`.
2. Each user opens **Connect Spotify**, which walks them through it:
   - create an app at <https://developer.spotify.com/dashboard>;
   - select **Web API** and **Web Playback SDK**;
   - add the redirect URI shown on screen (`<origin>/v1/auth/spotify/callback`);
   - paste the Client ID.
3. Up to 4 friends can sign in through someone else's app ("Join through a friend's app"). The app owner adds them under **User Management**, and they share the owner's quota.
4. Login failures are named on screen with their fix: redirect URI mismatch, user not on the allowlist, cancelled sign-in, or quota exceeded. Free accounts sign in as **remote only**: they can browse, chat and vote, but cannot run a speaker or DJ.
5. Option A (development only): set `SPOTIFY_DEV_CLIENT_ID` to use one shared app when a user has none.

The Spotify client targets the 2026 development-mode endpoints, falling back to the legacy paths if those fail:

- `POST /me/playlists`;
- `/playlists/{id}/items`;
- search capped at 10 results;
- `429 QUOTA_EXCEEDED` mapped to `quota_exceeded` for that user only.

If playlist writes are refused (403), that member's set falls back to a Spinroom-side list, and they are told why.

**Spotify branding:** the player panel shows Spotify's metadata and art unaltered, with attribution and **Open in Spotify** links. Replace the placeholder mark in `apps/web/src/room/PlayerPanel.tsx` (`SpotifyMark`) with the official logo from Spotify's brand kit before launch.

## Environment variables

Every variable is listed with comments in [`.env.example`](.env.example). The most important:

| Variable                                                                               | Purpose                                                                                |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`                                                                        | Public origin of web + `/v1` (also the OAuth issuer and the Spotify redirect base).    |
| `DATABASE_URL`, `REDIS_URL`                                                            | Postgres 16 and Redis 7.                                                               |
| `SESSION_SECRET`                                                                       | HMAC key for session JWTs (required in production).                                    |
| `ENCRYPTION_KEY`                                                                       | 32-byte base64 key sealing Spotify and Slack tokens at rest (required in production).  |
| `SPOTIFY_MODE`                                                                         | `real` or `fake` (fake is refused in production).                                      |
| `SERVICE_SECRET_SLACK`, `SERVICE_SECRET_MCP`                                           | Credentials the Slack and MCP services use for token exchange.                         |
| `MCP_RESOURCE_URL`                                                                     | Public URL of the MCP endpoint (the audience of MCP tokens).                           |
| `STORAGE_DRIVER`, `S3_*`, `ASSET_BASE_URL`                                             | Avatar storage: filesystem in dev, any S3-compatible store behind a CDN in production. |
| `AVATAR_SAFETY`                                                                        | `manual` review queue (default) or `auto_approve` (development only).                  |
| `ADMIN_SPOTIFY_IDS`                                                                    | Spotify user IDs who can review avatars at `/admin`.                                   |
| `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` | Slack app credentials.                                                                 |

## MCP: use Spinroom from a coding agent

The browser tab is the speaker; the agent is the remote. Agents never see Spotify tokens. **Profile → Connect agent** in the app shows copy-ready snippets and a one-time link code.

**Remote server (OAuth 2.1, recommended).** Deploy `apps/mcp` at `https://mcp.<domain>/mcp`. Clients discover the authorization server through `/.well-known/oauth-protected-resource`, register dynamically, and sign in with Spotify in a browser window. Tokens are audience-bound and can be revoked from the Profile page.

| Client                         | Setup                                                                     |
| ------------------------------ | ------------------------------------------------------------------------- |
| Claude Code                    | `claude mcp add --transport http spinroom https://mcp.<domain>/mcp`       |
| Claude Desktop / claude.ai     | Settings → Connectors → Add custom connector → paste the URL              |
| Codex (`~/.codex/config.toml`) | `[mcp_servers.spinroom]` with `url = "https://mcp.<domain>/mcp"`          |
| Cursor (`.cursor/mcp.json`)    | `{ "mcpServers": { "spinroom": { "url": "https://mcp.<domain>/mcp" } } }` |

**Local stdio (personal token).** For clients without remote MCP or OAuth support, including Grok and older clients:

```bash
SPINROOM_URL=https://<domain> npx -y spinroom-mcp login ABCD-1234   # code from Connect agent
```

```json
{ "mcpServers": { "spinroom": { "command": "npx", "args": ["-y", "spinroom-mcp"], "env": { "SPINROOM_URL": "https://<domain>" } } } }
```

Tools: `list_rooms`, `join_room`, `leave_room`, `now_playing`, `vote`, `search_tracks`, `crate_add`, `crate_list`, `crate_remove`, `crate_move`, `dj_queue_join`, `dj_queue_leave`, `skip_my_spin`, `create_room`, `invite`, `chat_send`, `room_history`.

- Resource: `spinroom://room/{slug}/now-playing` (subscribable).
- Prompt: `spinroom_session`.
- Every audio-related response includes `speaker_status`, plus a speaker link when no speaker is live.
- Agent writes are limited to 20 per minute per user.

## Slack app

1. Create the app from [`apps/slack/manifest.yml`](apps/slack/manifest.yml) after replacing `spinroom.example.com` with your origin. Then set the `SLACK_*` variables and run `apps/slack`.
2. Install it per workspace at `<origin>/v1/integrations/slack/install`.
3. In a channel, an owner or moderator runs `/spinroom link <room>`. A now-playing card appears and is edited in place, at most once every 3 s per channel. It is reposted after 50 newer messages.
4. Card buttons: **Hype**, **Skip**, **Join DJ queue**, **Open speaker**, **Add to my set**. The last opens a Spotify search modal.
5. Slash commands: `now`, `hype`, `skip`, `add <search>`, `dj`, `undj`, `invite @user`, `speaker`, `unlink`, `help`.
6. Each Slack user connects once with the **Connect Spinroom** button. It is a signed link that's valid for 15 minutes.

The manifest adds `channels:history` and `groups:history` to the PRD's scopes. Spinroom only uses them to count newer messages so it can repost the card. Before promoting a workplace "office radio", check Spotify's personal, non-commercial use terms.

## Testing

```bash
pnpm lint && pnpm typecheck
pnpm test        # unit + integration + contract tests (needs Postgres + Redis)
pnpm e2e         # Playwright journeys (starts its own API + web on :8081/:5174, fake Spotify)
pnpm size        # initial JS budget, after `pnpm --filter @spinroom/web build`
pnpm art         # rebuild the pixel art (fails if over the 400 KB budget)
```

Test databases: `spinroom_test`, `spinroom_test_mcp`, `spinroom_test_slack` and `spinroom_e2e`. `scripts/init-test-db.sql` creates the first one for Docker Compose; create the others the same way. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs everything above on every push.

What the automated checks cover, mapped to the PRD's acceptance checks:

| Phase | Check                                                                                                       | Status                                 |
| ----- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1     | Login and profile; Free accounts flagged remote-only; named setup failures                                  | Automated (API + Playwright)           |
| 2     | Every FR-D / FR-V rule, including ties, DJ leaving mid-spin, empty booth and cooldowns; 50 bots × 100 spins | Automated (34 engine tests)            |
| 3     | Late joiner starts at the live position; background tab keeps the speaker live; drift logic                 | Automated (fake player)                |
| 4     | Journeys 1 and 2; bundle budget (117.6 KB of 300 KB); reduced motion; avatar import plus each invalid case  | Automated                              |
| 5     | All tools; OAuth discovery, registration, PKCE, refresh and revocation; stdio login                         | Automated (in-memory and HTTP clients) |
| 6     | Card posting and updates; Slack vote reaches the web in < 1 s; ≤ 1 edit per 3 s under 20 votes in 10 s      | Automated (fake Slack API)             |

These still need real accounts or people:

- Spotify Client ID setup timed under 5 minutes.
- Two Premium accounts on two machines within 500 ms drift for 10 tracks.
- A real ChatGPT sprite kit import (confirm the format against a fresh export).
- Journey 3 in two real MCP clients.
- Journey 4 in a real Slack workspace.
- A staging deploy.
- Spotify policy review and a trademark search for the name.

## Deploying

Each service deploys separately (`Dockerfile` targets `api`, `mcp`, `slack`, `web`). Route one public origin as follows; `deploy/nginx.conf` is an example:

| Path                                                                                     | Service   |
| ---------------------------------------------------------------------------------------- | --------- |
| `/v1/*` (including the WebSocket `/v1/rooms/{slug}/live`)                                | api       |
| `/oauth/(authorize\|token\|register\|revoke)`, `/.well-known/oauth-authorization-server` | api       |
| `/v1/integrations/slack/*`                                                               | slack     |
| everything else                                                                          | web (SPA) |
| `mcp.<domain>/mcp`, `mcp.<domain>/.well-known/oauth-protected-resource`                  | mcp       |

- The API runs migrations on boot (`MIGRATE_ON_BOOT=0` disables this).
- Any API instance can serve any room: the Redis lock keeps one writer per room, and a 5 s ticker on each instance claims rooms through Redis.
- Use sticky sessions only if your platform needs them for WebSockets.
- Avatars go to S3-compatible storage behind a CDN, with immutable caching keyed by content hash.

## Security and privacy

- Spotify, Slack and MCP refresh tokens are sealed at rest (AES-256-GCM). Invite tokens and API tokens are stored only as hashes.
- Sessions use `HttpOnly`, `SameSite=Lax` cookies with double-submit CSRF protection on cookie-authenticated writes. Native clients get bearer tokens with rotating refresh tokens.
- Spotify access tokens go only to the user's own speaker page, which is origin-checked. Slack and MCP never handle Spotify tokens.
- All writes are rate limited per user and per IP and accept an `Idempotency-Key`. Errors are RFC 9457 problem JSON with stable `code`s.
- Chat is plain text, stripped of control and bidi-override characters, and capped at 500 characters.
- Individual votes are visible only to moderators, and the crowd animation is drawn from the aggregate. Users can delete their account from Profile; remaining personal data is purged within 30 days.
- Custom avatars:
  - imports require a rights confirmation;
  - they are shown only to their owner until approved;
  - anyone can report one;
  - room moderators can hide one in their room;
  - admins can remove one everywhere;
  - repeated confirmed violations revoke upload access.

  Publish a notice-and-takedown contact for rights holders before launch.

## Originality

All built-in art, characters, the scene and the vocabulary (Hype/Skip, crate, booth, bounce) are original to Spinroom. Nothing references Turntable.fm's names, assets, layouts or code. "Spinroom" is a working title.

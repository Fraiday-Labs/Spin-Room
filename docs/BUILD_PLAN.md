# Spinroom v1 — Build Plan

## Context

`palarkin/Spin-Room` is empty (branch `claude/beautiful-edison-6suue8`, no commits). The PRD (Oct 7, 2026) specifies Spinroom: social DJ rooms where each listener's own Spotify Premium account plays the track in a browser "speaker" tab, while the server owns rooms, DJ rotation, votes and sync. Three surfaces share one `/v1` API: web app, MCP server, Slack app. This plan turns the PRD's six-phase build plan into concrete, executable steps in this container.

**Environment facts (verified):** Node 22.22, pnpm 10.28, Postgres 16 and Redis 7 installed natively (cluster currently down; no Docker daemon), npm registry reachable. Current versions: fastify 5.12, @fastify/websocket 11.3, @fastify/cookie 11.1, zod 4.6, drizzle-orm 0.45 / drizzle-kit 0.31, postgres 3.4, ioredis 6.0, ws 8.22, vite 8.3, react 19.3, @tanstack/react-query 5.104, vitest 5.0, sharp 0.35, fflate 0.8, uuidv7 1.2, @modelcontextprotocol/sdk 1.32, @slack/bolt 5.1.

**Cross-cutting decisions**

- **Fake Spotify mode** (`SPOTIFY_MODE=fake`): fake PKCE login (pick a seeded user), fixture track catalog for search, fake playlists, and a silent simulated speaker that reports positions. This lets the API, MCP, Slack and Playwright journeys run fully here without Premium accounts. Real mode is the default in production.
- **Sets:** playlist-backed per FR-C1 through a `SpotifyGateway`. If a playlist write returns 403 in dev mode, that member's set automatically falls back to Spinroom-side `crate_items` with read-only import (the PRD's Phase 1 fallback).
- **Art:** all scene plates, crowd back-view sprites, preset avatars and laptop marks are original pixel art written as palette-indexed text pixel maps in `tools/art/`, compiled to WebP/PNG with sharp. Nothing is taken from Turntable.fm or the reference image's OS logos. Fonts: Pixelify Sans and VT323 (OFL), self-hosted via `@fontsource`.
- **Image safety:** an `ImageSafetyProvider` interface. The default provider is a manual review queue (status stays `pending` until an admin approves); a hosted moderation provider can be added later.
- **Object storage:** an S3-compatible driver plus a local filesystem driver with the same interface for dev; files keyed by SHA-256.
- **Token encryption:** AES-256-GCM envelope encryption with a key from env (`ENCRYPTION_KEY`), behind a `Sealer` interface so KMS can replace it.
- Docker Compose for Postgres/Redis/MinIO is committed for contributors; in this container I start the native services instead.

## Repo layout (pnpm workspaces)

```
apps/api        Fastify REST + WS, room runtime, OAuth AS for MCP, avatar pipeline
apps/web        Vite + React SPA (landing, lobby, room, speaker, studio, settings)
apps/mcp        MCP server: Streamable HTTP (remote) + stdio bin `spinroom-mcp`
apps/slack      Bolt (HTTP receiver) service
packages/contracts    Zod schemas: REST routes, events, error codes, settings, avatar mapping
packages/room-engine  Pure TS rules engine (no I/O), injected clock + store
packages/sdk          Typed REST + WS client built on contracts (used by web, mcp, slack)
tools/art       Pixel-map sources + build script → apps/web/public/art
docs/design/pixel-neon-dj.md   Design system (tokens, layers, generation prompt)
```

Root: `tsconfig.base.json` (strict), ESLint flat config + Prettier, `vitest.workspace.ts`, `docker-compose.yml`, `.env.example` (every secret), `scripts/seed.ts` (2 rooms, 3 fake users), `.github/workflows/ci.yml` (lint, typecheck, unit, API integration with Postgres + Redis services, Playwright, bundle-size check), `README.md`.

---

## Phase 1 — Foundations

**contracts** (`packages/contracts/src/`)

- `ids.ts` (UUIDv7 brand), `errors.ts` (stable codes: `not_premium`, `crate_empty`, `on_cooldown`, `speaker_missing`, `quota_exceeded`, `rate_limited`, `invalid_invite`, … + RFC 9457 problem schema).
- `settings.ts`: `RoomSettings` with every PRD default (maxPresent 100, boothSlots 3 (1–3), skipRatio 0.5, minSkips 2, bounceAfter 2, bounceCooldownMs 5 min, turnLimit off, maxTrackMs 10 min, noRepeatWindow off/20, blockExplicit off, inviteTtl 7 d, pauseAfterNoSpeakerMs 2 min, remotePresenceMs 15 min, recentListenMs 10 min, djPresenceDropMs 60 s, chat 5/10 s).
- `routes.ts`: a route registry — every REST endpoint from the PRD's table as `{method, path, params, query, body, response, auth}`. `events.ts`: discriminated union of all WS events with `seq`. `avatar-mapping.json` (state → pet row + fallback).
- `scripts/openapi.ts` generates `openapi.json` from the registry via `z.toJSONSchema`.

**api skeleton** (`apps/api/src/`)

- `app.ts` Fastify factory; plugins: config (zod-validated env), logger (pino with roomId/spinId), problem-json error handler, rate limit (Redis), idempotency (`Idempotency-Key` cached 24 h in Redis), CSRF (double-submit header for cookie-auth writes), CSP/security headers, CORS.
- `db/schema.ts` Drizzle tables exactly per the PRD data model, plus `avatars`, `avatar_reports`, `sessions`, `oauth_clients`, `oauth_codes`, `points`. `db/migrations/` via drizzle-kit. `redis.ts` (ioredis client + pub/sub client).
- **Auth** `routes/auth.ts`: `GET /v1/auth/spotify/start?client_id=` (validates Client ID format = 32 hex, creates PKCE verifier + state in Redis 10 min, remembers Client ID in long-lived cookie), `GET /v1/auth/spotify/callback` (code exchange with no secret, `GET /me`, read `product`, upsert user keyed by `spotify_user_id`, seal tokens, create session). Maps failures to named causes: redirect URI mismatch, user not allowlisted (403 from `/me`), not Premium. `POST /v1/auth/session/refresh`, `/logout`. Sessions: HttpOnly/Secure/SameSite=Lax cookie **and** bearer access JWT (15 min) + rotating refresh token for native clients.
- `GET/PATCH /v1/me`, `GET /v1/me/spotify-token` (origin-checked, refreshes server-side), `GET /v1/time`.
- `spotify/gateway.ts`: `SpotifyGateway` interface + `RealSpotifyGateway` (fetch, retries with backoff on 429/5xx, `QUOTA_EXCEEDED` → per-user `quota_exceeded` error) + `FakeSpotifyGateway`.

**web (phase 1 slice):** Landing, guided **Connect Spotify** setup screen (steps, callback URL with copy button, Client ID input, failure diagnostics, "Join through a friend's app" path), Profile showing Premium/remote-only badge.

**Checks:** API integration test for login (fake mode) creates user, Free account flagged `remote_only`; manual: real Client ID setup timed under 5 min (needs the user).

## Phase 2 — Room engine

**room-engine** (`packages/room-engine/src/`): pure reducer
`apply(state, command, now) → { state, events[], effects[] }`

- Commands: `memberJoin/Leave`, `presence` (speaker heartbeat, remote action), `queueJoin/Leave`, `vote`, `skip` (dj | mod), `timerFired(spinId)`, `setUpdated` (crate head/length), `settingsChanged`, `boothLeave`, `sweep(now)`.
- Effects: `scheduleTimer(at, spinId)`, `persistSpin`, `persistVote`, `requestNextTrack(djId)`, `notifyUpNext(userId)`.
- Rules, each in its own module with tests: rotation.ts (FR-D1–D5, D8, L4, L5), voting.ts (FR-V1–V7, V2 eligibility, L3), lifecycle.ts (FR-R5 idle, FR-L1 pause/resume, FR-D4 60 s drop), timing.ts (end = start + duration + 2 s grace; auto-skip 3 s fade).
- `simulate.ts`: seeded random bot driver.

**api room runtime** (`apps/api/src/rooms/`)

- `RoomRuntime`: loads state from `room:{id}:state` (rebuild from Postgres if missing), takes `room:{id}:lock` (SET NX PX, single writer), applies command, writes state + Postgres rows, publishes events with incrementing `seq` to `events:room:{id}`, releases lock. Timer ticks are idempotent (guarded by spinId); on boot, all active rooms' timers are rescheduled from `startedAtServerMs`.
- Endpoints: rooms CRUD/list (public directory with live counts), join/leave, invites (token hash only, expiry, revoke, accept), crate (list/add/patch/delete/import, set linking/creating "Spinroom – <room>" playlist, snapshot-ID re-read before each spin, explicit/unplayable/too-long flagged at add), dj-queue, vote, skip, history (last 200), chat (5/10 s, 500 chars, escaped), moderation (kick, ban, mute, end spin, roles, `hide_avatar`).
- WS `/v1/rooms/{slug}/live`: `room.snapshot` on connect; fan-out from Redis pub/sub; client `resync` request on missed `seq`. Votes per user only to moderators.

**Checks:** unit tests for every FR-D and FR-V rule including ties, DJ leaving mid-spin, empty booth, cooldowns; simulation of 50 bots × 100 spins with invariant checks (no duplicate booth users, one vote per user per spin, seq monotonic); API integration tests per endpoint + contract tests (responses parse against contracts; every registry route is implemented).

## Phase 3 — Speaker and sync

- `POST /v1/speakers` (`kind: web_sdk`, abstract for future native), `POST /v1/speakers/{id}/heartbeat` (position, drift; drives presence), one-live-speaker-per-member with "move speaker" takeover.
- web `speaker/`: `clock.ts` (ping `/v1/time` every 30 s, median of last 5 offsets), `spotifySdk.ts` (loads SDK script, device "Spinroom — <room>"), `syncLoop.ts` (play via `PUT /me/player/play` with `device_id/uris/position_ms`; every 5 s `getCurrentState()`; seek if drift > 500 ms; reload after two > 3 s; 3 s fade on `spin.ended`), device-lost → "Paused — Spotify is playing elsewhere" + Reclaim, local volume/mute. `FakeSpeaker` implements the same interface for fake mode.
- Speaker status banner states: off, starting, live, paused elsewhere, error.
- Metrics: drift histogram and join-to-audio time logged via heartbeat.

**Checks:** unit tests for clock math and drift decisions (fake timers); Playwright: late joiner computes correct position, background tab keeps heartbeating in fake mode. Manual (user): two Premium accounts on two machines < 500 ms for 10 tracks.

## Phase 4 — Web room UI and Avatar studio

**Design system:** `docs/design/pixel-neon-dj.md` (tokens table, layer table, scene rules, generation prompt). `apps/web/src/styles/tokens.css` with the PRD hex tokens.

**Art build** (`tools/art/build.ts`): pixel maps → back wall + truss, speaker stacks, booth, floor plates (480×270 layers), ~8 crowd back-view sprites (hoodie, beanie, pigtails, small robot, hooded mascot…, tinted per member color), 6 preset front avatars with idle/hype/skip/DJ/walk/wave/waiting rows, Spinroom laptop mark. Output WebP; budget check < 400 KB total.

**Screens** (wouter router, TanStack Query, small `useSyncExternalStore` live store):

- Lobby (my rooms, lazy public directory, create room, avatar picker), Room, Room settings, Profile (studio, points, linked Slack/MCP, personal tokens, delete account), Connect agent (MCP snippets per client + one-time link code).
- **Stage** (`room/stage/`): 480×270 container scaled to fill with `image-rendering: pixelated`; layers: wall/truss + 5 spotlights (active DJ's brightens), speaker stacks with LED strips, synthetic EQ bars, booth DJs with name labels in slot colors (cyan/magenta/amber), LED marquee (amber VT323 "Artist – Title", elapsed/remaining, scrolls when long), crowd (one sprite per present member; hands up on Hype, turn away on Skip; dimmed + headphone-off for remote-only). Transforms/opacity only, ≤ 3 flashes/s, paused when hidden, frozen under reduced motion.
- **Spotify player panel**: unaltered album art, title, artist, Spotify logo, "Open in Spotify", progress, local volume/mute, big Hype/Skip buttons (icon + text, never color-only), Skip spin for DJ/mods.
- Right rail tabs (bottom sheet on narrow screens): Up next (3 spins), Chat (emoji reactions), DJ queue, My set (search, add, reorder, remove, link playlist).
- Toasts (up next, bounced, crate ran out), ARIA live region for track changes/vote outcomes, shortcuts `H S Q / ?`.

**Avatar pipeline** (`apps/api/src/avatars/`): `ingest.ts` (10 MB cap; fflate zip with only `pet.json` + named sheet, no nested paths/traversal, 20 MB expansion cap), `sniff.ts` (magic bytes; still PNG/WebP with alpha), `layout.ts` (1536×1872 v1, 1536×2288 v2, else divisible-by-192×208 → manual grid prompt, else named-sizes error), `petJson.ts` (≤ 64 KB, known fields only, name ≤ 32), `frames.ts` (transparent-cell frame counting; idle required, warnings for other mapped rows), `build.ts` (mapped rows only, cells → 96×104, strip metadata, WebP ≤ 150 KB; 128×128 PNG thumb from first idle frame), content-hash storage + dedupe, `safety.ts`. Endpoints per PRD (`POST /v1/avatars` multipart with validation report + preview URLs, mine, get, delete, `PUT /v1/me/avatar`, report), admin review queue + remove-everywhere + upload revocation after repeated violations. Max 5 customs per user. `presence.changed` carries thumb + sheet URLs.

- Studio page: how-to steps, drop zone, rights confirmation checkbox (required), validation report with named fixes, live preview of each mapped state on a mock floor and booth, save/switch.

**Checks:** Playwright Journeys 1 and 2 in fake mode; Vite bundle check < 300 KB gzipped initial JS (CI fails above); reduced-motion test; avatar tests with generated fixtures (sprite-kit zip, v1 sheet, v2 sheet, pet folder pair) plus each invalid case asserting its named error. Manual: real ChatGPT sprite kit import (user supplies one; confirm format).

## Phase 5 — MCP server

- **OAuth 2.1 AS in apps/api** (`routes/oauth.ts`): `/.well-known/oauth-authorization-server`, dynamic client registration, `/oauth/authorize` (web login + consent screen), `/oauth/token` (PKCE, refresh), audience-bound JWTs for the MCP resource. Personal access tokens: `POST/DELETE /v1/tokens` (hash-only).
- `apps/mcp/src/tools/*.ts`: all 17 PRD tools, each calling `@spinroom/sdk`; compact text + `structuredContent`; `speaker_status` + speaker URL whenever audio context matters; descriptions state votes/chat are visible; `now_playing` includes the up-next field (FR-L4). Resource `spinroom://room/{slug}/now-playing` with subscriptions fed by the WS. Prompt `spinroom_session`. Per-user write limit 20/min (enforced by API).
- `http.ts`: Streamable HTTP at `/mcp` + `/.well-known/oauth-protected-resource`; `stdio.ts`: bin `spinroom-mcp` using `SPINROOM_TOKEN`.

**Checks:** MCP SDK in-memory client tests for every tool (fake mode); manual: Journey 3 in Claude Code + one other client (user).

## Phase 6 — Slack app

- `apps/slack`: Bolt HTTP receiver at `/v1/integrations/slack/{events,interactivity,commands,oauth}` (ingress routes that prefix to this service; Socket Mode only when `SLACK_SOCKET_MODE=1` locally), multi-workspace OAuth install with the PRD bot scopes, `slack_installs` with sealed bot tokens.
- Account linking: "Connect Spinroom" → web login → `identity_links`. The Slack service gets per-user access via `POST /v1/auth/token-exchange` (service credential + linked Slack ID → short-lived user token), so it uses only public endpoints.
- `card.ts` Block Kit now-playing card (album art, title/artist, DJ + booth thumbs, progress text, "Hype 6 · Skip 1", buttons Hype/Skip/Join DJ queue/Open speaker/Add to my set). `cardSync.ts` subscribes to room events and edits via `chat.update`. Vote changes are debounced to at most one edit per 3 s per channel, and the card is reposted after 50 newer messages. Slash commands: link/unlink (owner/mod), now (ephemeral), hype/skip, add (search modal), dj/undj, invite @user (DM), speaker (DM). Up-next DMs (FR-L4).

**Checks:** signed-request tests for commands/actions; debounce test (20 votes in 10 s → ≤ 4 edits); vote via Slack → web WS event < 1 s in integration test. Manual: Journey 4 in a real test workspace (user).

---

## Execution approach

- Build phases in order. Each phase opens by restating its scope and closes by running its checks, committing, and pushing to `claude/beautiful-edison-6suue8`. Each phase report lists anything deferred. No PR unless asked.
- Contracts and room-engine are written first and frozen per phase. After Phase 4's API surface is stable, Phases 5 and 6 can be built in parallel by subagents.
- README covers local setup (native or Compose), env vars, Spotify app setup (option B), Slack manifest (`apps/slack/manifest.yml`), MCP install for Claude Code, Claude Desktop, Codex, Cursor and Grok.

## Verification (end to end, in this container)

1. `pg_ctlcluster 16 main start && redis-server --daemonize yes`, then `pnpm i && pnpm db:migrate && pnpm seed`.
2. `pnpm lint && pnpm typecheck && pnpm test` (units, simulation, API integration + contract tests, avatar fixtures, MCP and Slack tests).
3. `SPOTIFY_MODE=fake pnpm dev`, then `pnpm e2e` (Playwright on the preinstalled Chromium: Journeys 1 and 2, late joiner, reduced motion) and `pnpm size` (bundle budget).
4. Screenshot the room stage with Playwright to check the Pixel Neon DJ scene visually.

**Needs the user (cannot be done here):** real Spotify Client ID + Premium accounts (Phase 1 timing, Phase 3 drift across two machines), a real ChatGPT sprite kit, a Slack test workspace, two real MCP clients, staging deploy/hosting choice, Spotify policy review, trademark search.

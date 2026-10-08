# Spinroom PRD — Social DJ Rooms on Spotify

Oct 7, 2026 · @Pete Larkin

## Overview and vision

Spinroom (working title) is a lightweight, nostalgic web app where friends gather in shared music rooms, take turns DJing from Spotify, and vote each track up or down. The room is drawn as a simple 2D scene with avatars, a DJ booth, and a crowd that reacts to votes.

Spinroom never streams audio itself. Every listener connects their own Spotify Premium account, and the app tells each listener's browser to play the same track at the same position. Spinroom owns the room, the DJ rotation, the votes, and the sync; Spotify owns the music and its licensing.

The same room is reachable from three surfaces that share one backend:

- **Web app** — the full visual room and the audio "speaker" for each listener.
- **MCP server** — join, invite, DJ, and vote from coding agents such as Claude, Codex, and Grok.
- **Slack app** — a live now-playing card in a channel with voting and queue controls.

The guiding mental model: the browser tab is the speaker, and Slack or a coding agent is the remote control.

## Goals, non-goals, and success metrics

The v1 goal is a stable shared room where everyone hears the same track within about half a second, and can DJ and vote from the web, Slack, or a coding agent.

**Goals**

1. Synced group listening on Spotify with no audio re-streaming.
2. A fair, fun DJ rotation driven by crowd votes, including auto-boot.
3. A charming, lightweight 2D room that loads fast on an ordinary laptop.
4. One client-agnostic backend API that the web app, MCP server, and Slack app all use.
5. Easy invites: share a link, a Slack channel, or an MCP command.

**Non-goals for v1**

- Native mobile apps (architecture must allow them later; see the mobile section).
- Hosting, uploading, or streaming any audio files.
- Support for Spotify Free accounts as listeners.
- Other music services (Apple Music, YouTube Music).
- 3D graphics, heavy animation engines, or game-engine rendering.
- Monetization, ads, or paid tiers.

**Success metrics (targets to validate after launch)**

| Metric | Target |
| --- | --- |
| Playback drift between listeners | under 500 ms for 95% of samples |
| Room join to first audio | under 5 s with Spotify already connected |
| Vote reflected on all surfaces | under 1 s |
| Initial web bundle size | under 300 KB gzipped, excluding the Spotify SDK |
| Weekly active rooms | baseline set at launch |
| Share of votes cast from Slack or MCP | tracked to judge surface value |

## Users and core journeys

Three personas cover v1, and every one of them needs Spotify Premium to hear audio.

| Persona | Where they live | What they want |
| --- | --- | --- |
| Friend group listener | Web app | Hang out, hear new music, vote, take a DJ turn |
| Developer in flow | Claude, Codex, Grok, other MCP clients | Keep music going while coding; vote or queue without leaving the editor |
| Team in Slack | A Slack channel | A shared office radio; see what's playing and react in-channel |

**Journey 1 — Create and invite (web)**

1. User signs in with Spotify; the app confirms Premium.
2. User creates a room (name, public or invite-only, vote threshold).
3. User copies an invite link and shares it.
4. User clicks "Start speaker" so audio can play in this tab.

**Journey 2 — Join and DJ (web)**

1. Friend opens the invite link and signs in with Spotify.
2. Friend lands in the 2D room, sees avatars and the current track, and audio starts at the live position.
3. Friend clicks "Join DJ queue", searches Spotify, and adds tracks to their personal crate.
4. When their turn comes, their avatar steps up to the booth and their next crate track plays.

**Journey 3 — Remote control from a coding agent (MCP)**

1. Developer installs the Spinroom MCP server and links it once to their Spinroom account.
2. Developer asks the agent to join a room; the agent returns a speaker link if no speaker tab is open.
3. With the tab in the background, the developer asks the agent "what's playing", "vote awesome", or "add this song to my crate".
4. Developer asks the agent to invite a friend; the agent returns a shareable invite.

**Journey 4 — Room in Slack**

1. A workspace admin installs the Slack app and runs `/spinroom link <room>` in a channel.
2. A live now-playing card appears and updates on each track change.
3. Members tap Awesome or Lame, join the DJ queue, or open the speaker link from the card.

## Core concepts and glossary

These terms are used consistently across code, API, and UI copy. Spinroom deliberately uses its own vocabulary rather than Turntable.fm's.

| Term | Meaning |
| --- | --- |
| Room | A persistent space with members, a booth, a DJ queue, and a now-playing state |
| Booth | Up to 3 DJ slots at the booth; DJs take turns in slot order |
| DJ queue | Ordered waitlist of members who want a booth slot |
| Crate | The Spotify playlist a member links as their set; Spinroom plays it in order on their turns (UI label: "My set") |
| Spin | One track played by one DJ; the unit of voting |
| Hype / Skip | The two vote types (UI copy; avoid "awesome"/"lame") |
| Crowd score | Hype minus Skip for the current spin, plus percentage of present listeners |
| Auto-skip | The current spin ends early when Skip votes cross the threshold |
| Bounce | A DJ is removed from the booth after repeated auto-skips |
| Speaker | A browser tab running the Spotify Web Playback SDK that produces audio for one member |
| Remote | Any surface that controls the room without playing audio (Slack, MCP, a second web tab) |
| Presence | Whether a member is currently in the room, and whether their speaker is live |
| Room clock | Server-authoritative start time of the current spin, used for sync |

## Functional requirements

All rules below run on the server; clients only send intents and render state. Every configurable number is a room setting with the default shown.

### Rooms

- FR-R1: A signed-in user can create a room with name, slug, description, visibility (public or invite-only), and settings.
- FR-R2: Invite-only rooms are joined by a signed invite token (link), a Slack channel link, or an MCP invite. Tokens can expire (default 7 days) and be revoked.
- FR-R3: Room roles: owner, moderator, member. Owner and moderators can kick, ban, mute chat, end a spin, and edit settings.
- FR-R4: Max members present at once: 100 (setting). Max booth slots: 3 (setting, 1 to 3), matching the booth art.
- FR-R5: A room with no DJs goes idle and plays nothing. It shows "Booth open — step up".
- FR-R6: Rooms persist; history keeps the last 200 spins with their scores.
- FR-R7: Lightweight text chat in the room, with emoji reactions. Messages are rate limited (5 per 10 s per user).

### DJ rotation

- FR-D1: A member can join the DJ queue only if their crate holds at least 1 playable track.
- FR-D2: When a booth slot opens, the first person in the DJ queue takes it.
- FR-D3: DJs on the booth play in round-robin slot order, one spin per turn.
- FR-D4: A DJ can leave the booth at any time. A DJ whose presence drops for over 60 s is removed from the booth.
- FR-D5: Optional turn limit: after N spins (default off), a DJ returns to the back of the DJ queue if others are waiting.
- FR-D6: The next spin is the next unplayed track in the DJ's linked playlist; after the last track it wraps to the top.
- FR-D7: Tracks longer than 10 minutes (setting) are refused at add time.
- FR-D8: Optional per-room rule to block the same track within the last 20 spins.

### Crates

- FR-C1: Each member links one Spotify playlist per room as their set, or has Spinroom create one. The set is the DJ's queue (see Player and queue come from Spotify).
- FR-C2: Members add tracks to their set by searching Spotify from the web, Slack, or MCP; Spinroom appends them to the linked playlist. Reordering and removing can happen in Spinroom or directly in Spotify.
- FR-C3: Unplayable tracks (region-locked or removed) are flagged when added and skipped at play time with a notice.

### Voting, auto-skip, and bounce

- FR-V1: Every present member except the current DJ can cast one vote per spin: Hype or Skip. Votes can be changed until the spin ends.
- FR-V2: Only members with a live speaker, or who heard audio in the last 10 minutes, count toward the eligible voter total. This stops absent remotes from dominating.
- FR-V3: Auto-skip fires when Skip votes are at least 50% of eligible voters (setting) and at least 2 Skip votes (setting). The spin ends with a 3 s fade.
- FR-V4: Bounce fires when a DJ gets 2 auto-skips in a row (setting). The DJ leaves the booth and goes to the back of the DJ queue. A bounced DJ cannot rejoin the queue for 5 minutes (setting).
- FR-V5: A Hype-heavy spin (Hype at least 50% of eligible voters) earns the DJ "points" shown on their profile; points have no other effect in v1.
- FR-V6: Votes are visible to everyone in aggregate; who voted what is visible only to moderators.
- FR-V7: The DJ can skip their own spin. Moderators can end any spin.

### Presence and avatars

- FR-P1: Members choose an avatar from a set of original preset characters with color variants, or upload a pet they made in ChatGPT (see Custom avatars).
- FR-P2: Presence states: in room with live speaker, in room as remote only, away.
- FR-P3: Avatars react to the crowd score: nodding on Hype, frowning on Skip, booth glows on a Hype-heavy spin.

### Custom avatars (made in ChatGPT)

Members design their avatar as a pet in ChatGPT, download it, and upload it to Spinroom. Spinroom reads the ChatGPT and Codex pet format directly, so there is no template to fill in and no drawing tool to build. Every import passes automatic checks and a safety scan before anyone else sees it.

**Accepted files**

| Input | Contents | Where it comes from |
| --- | --- | --- |
| Sprite kit (`.codex-pet.zip`) | `pet.json` + `spritesheet.webp` | "Download sprite kit" in ChatGPT's Pets settings |
| Single sprite sheet | One PNG or WebP | A pet sheet saved from ChatGPT on the web, or any sheet drawn in the same layout |
| Pet folder files | `pet.json` + `spritesheet.webp` or `.png`, picked together | A pet already installed under `~/.codex/pets/` |

**Source format** (community-documented; confirm against a fresh ChatGPT export at the start of Phase 4)

- A grid of 192 × 208 px cells, 8 columns wide.
- Version 1 is an 8 × 9 grid (1536 × 1872 px). Version 2 is 8 × 11 (1536 × 2288 px); its 2 extra rows hold 16 look directions.
- The 9 standard rows are idle, running-right, running-left, waving, jumping, failed, waiting, running, and review.
- `pet.json` names the pet and its sprite sheet file; version 2 sets `spriteVersionNumber: 2`.

Sources: [Petdex format notes](https://github.com/crafter-station/petdex), [v2 layout example](https://github.com/rushairer/codex-pets), [sprite kit download](https://penchan.co/ja/ai/coding/codex-pets/), [ChatGPT web upload example](https://github.com/mySebbe/malou-codex-pet/releases/tag/v2.0.0).

**Mapping pet rows to Spinroom states**

| Spinroom state | Pet row used | If that row is empty |
| --- | --- | --- |
| Idle on the dance floor | idle | Required; import fails |
| Hype reaction | jumping | idle |
| Skip reaction | failed | idle |
| DJing in the booth | running | idle |
| Walking in | running-right | idle |
| Waving hello | waving | idle |
| Remote only or away | waiting | idle, dimmed |

The running-left and review rows and the version 2 look directions go unused in v1. The mapping lives in one config file, so it can change without code changes.

**Import pipeline (server-side)**

- FR-A1: Accept uploads up to 10 MB. For zips, read only `pet.json` and the sprite sheet it names; reject other files, nested paths, path traversal, and archives that expand past 20 MB.
- FR-A2: Detect file type from its bytes, not its extension. Accept only still PNG or WebP images with an alpha channel.
- FR-A3: Detect the layout from dimensions (1536 × 1872 or 1536 × 2288). For other sizes that divide evenly into 192 × 208 cells, offer manual grid entry; otherwise reject and name the expected sizes.
- FR-A4: Prefill the avatar name (up to 32 characters) from `pet.json`. Treat `pet.json` as untrusted: cap it at 64 KB, parse only known fields, and never execute it or render it as HTML.
- FR-A5: Count frames per row by finding fully transparent cells. Reject if the idle row is empty; warn about other empty mapped rows.
- FR-A6: Build a Spinroom runtime sheet: keep only the mapped rows, downscale each cell to 96 × 104 px, strip metadata, and re-encode as WebP. Reject if the result exceeds 150 KB. Keep the original file so sheets can be rebuilt if the mapping changes.
- FR-A7: Store files by SHA-256 content hash; identical uploads reuse stored files.
- FR-A8: Errors name the problem and the fix, for example "This image is 1024 × 1024. ChatGPT pet sheets are 1536 × 1872 or 1536 × 2288 — use Download sprite kit in ChatGPT."

**Avatar studio page**

- FR-A9: A short how-to with screenshots: create a pet in ChatGPT, open its Pets settings, choose Download sprite kit, then drop the zip on this page.
- FR-A10: A live preview shows each mapped state animating on a mock dance floor and booth before saving.
- FR-A11: Each user can save up to 5 custom avatars and switch between them and the presets at any time.
- FR-A12: Before upload, the user confirms they have the right to use the art and that it does not depict a copyrighted or trademarked character. ChatGPT can still produce look-alikes of famous characters, so this check and moderation stay in place.

**Safety and moderation**

- FR-A13: Each import runs through an automated image-safety check. Until it passes, only the owner sees the custom avatar; everyone else sees the owner's preset.
- FR-A14: Any member can report an avatar from a member's profile card. Reports go to a global review queue.
- FR-A15: Room moderators can hide a member's custom avatar in their room; that member then shows with a preset there.
- FR-A16: Admins can remove an avatar everywhere. Spinroom publishes a notice-and-takedown contact for rights holders, and users with repeated confirmed violations lose upload access.

**Display on every surface**

- FR-A17: The web room lazy-loads runtime sheets only for avatars on screen and caches them by hash, keeping a 100-person room within budget.
- FR-A18: The server renders a static 128 × 128 PNG thumbnail from the first idle frame. Slack cards and MCP responses use it, since they cannot animate sprites.

**Storage, data, and API**

- Files live in S3-compatible object storage behind a CDN, named by content hash, with long-lived immutable caching.
- Table `avatars`: id, owner\_id (null for presets), name, kind (preset or custom), source\_format (pet\_v1, pet\_v2, single\_sheet), original\_url, sheet\_url, thumb\_url, sha256, frame\_counts, pet\_json (sanitized), status (pending, approved, rejected, removed), created\_at. `users.avatar_id` points to it.
- Table `avatar_reports`: id, avatar\_id, reporter\_id, room\_id, reason, created\_at, resolved\_at, resolution.
- Endpoints: `POST /v1/avatars` (multipart; zip, image, or `pet.json` + image; returns a validation report and preview URLs), `GET /v1/avatars/mine`, `GET /v1/avatars/{id}`, `DELETE /v1/avatars/{id}`, `PUT /v1/me/avatar`, `POST /v1/avatars/{id}/report`, plus a `hide_avatar` room moderation action.
- Event `presence.changed` carries the member's current thumbnail and sheet URLs, so every client updates when someone switches avatars.

**Later (not v1)**

- Import by a ChatGPT pet share link, if those links expose the files.
- Use the running-left row and the look directions for richer movement on the dance floor.

### Room lifecycle and remotes

- FR-L1: If no member has a live speaker for 2 minutes, the room pauses: spins stop advancing and the booth and DJ queue are kept. It resumes when a speaker goes live.
- FR-L2: Slack and MCP actions mark a member present as a remote for 15 minutes after their last action; `join_room` and any vote refresh it.
- FR-L3: Votes from Slack or MCP count toward auto-skip only when that member's speaker is live (FR-V2 applies on every surface).
- FR-L4: The next DJ gets an "up next" notice one spin ahead, on the surface they used last (web toast, Slack DM, or a field in MCP `now_playing`).
- FR-L5: If a DJ's crate runs out during their turn, they step down from the booth and get a notice.
- FR-L6: Room setting to block explicit tracks (default off), using Spotify's explicit flag on each track.

## Spotify integration and playback sync

Each listener plays the track on their own Premium account through a speaker tab; the server only decides what plays and when. This keeps Spotify responsible for licensing and keeps Spinroom out of audio delivery entirely.

### Authentication

- Spotify OAuth 2.0 Authorization Code flow with PKCE, handled by the backend, using the user's own Spotify Client ID (option B under platform access below).
- Scopes: `streaming`, `user-read-email`, `user-read-private`, `user-read-playback-state`, `user-modify-playback-state`, `playlist-read-private`, playlist-modify-public, playlist-modify-private.
- On login, read the account `product` field. Spinroom is Premium-only (decision, Oct 2026): non-Premium accounts are refused with a clear explanation, nothing is stored for them, and existing users who downgrade are signed out.
- Refresh tokens are stored encrypted server-side. Access tokens are refreshed by the backend and handed to the speaker tab on request; they never go to Slack or MCP clients.
- Spinroom accounts are keyed to the Spotify user ID. Slack and MCP identities are linked to that account (see those sections).

### The speaker tab

- The speaker is a page in the web app that loads the Spotify Web Playback SDK and registers a device named "Spinroom — \<room name>".
- Browsers block autoplay, so the speaker starts only after one click on "Start speaker". After that it runs in a background tab.
- One live speaker per member per room. Opening a second one asks to move the speaker.
- The speaker sends a heartbeat every 15 s with its playback position and drift. Presence uses this heartbeat.
- If the user plays something else on Spotify elsewhere, the SDK reports the device lost. The speaker shows "Paused — Spotify is playing elsewhere" and offers "Reclaim".

### Sync algorithm

1. When a spin starts, the server writes `startedAtServerMs` and broadcasts `spin.started` with the track URI and duration.
2. Each client keeps a clock offset to the server using a ping exchange every 30 s (median of the last 5 round trips, NTP-style).
3. The speaker computes `positionMs = now + offset − startedAtServerMs` and starts playback on its device through the Spotify Web API (`PUT /me/player/play` with `device_id`, `uris`, `position_ms`). Late joiners use the same formula.
4. Every 5 s the speaker reads `getCurrentState()`. If drift exceeds 500 ms, it seeks to the expected position; if drift exceeds 3 s twice in a row, it reloads the track.
5. At the expected end, the server advances to the next spin. The server, not any client, owns track transitions, using a timer per room plus a 2 s grace window.
6. Auto-skip or a manual skip broadcasts `spin.ended` with a reason; speakers fade over 3 s and wait for the next `spin.started`.

### Search and metadata

- Track search goes through a backend proxy using the requesting user's Spotify token, refreshed server-side and cached for 10 minutes per query. Slack and MCP never handle Spotify tokens.
- Store the track URI, title, artists, album art URL, and duration on each spin. Album art is loaded from Spotify's CDN and shown with Spotify attribution.

### Player and queue come from Spotify

Spotify is the player and the source of every DJ's queue; Spinroom only decides whose turn it is. The pixel scene mirrors Spotify's state but never replaces it.

- **Player**: each listener's speaker tab is a Spotify Connect device running the Web Playback SDK. The player panel shows Spotify's own metadata and artwork unaltered, with the Spotify logo and links back to the track in Spotify, following Spotify's design guidelines.
- **DJ sets are Spotify playlists**: each member links one of their Spotify playlists as their set for a room, or lets Spinroom create one named "Spinroom – \<room name>" in their account. Spinroom plays it top to bottom and remembers the position per room.
- **Edits flow both ways**: changes made in the Spotify app show up before the DJ's next spin (Spinroom re-reads the playlist when its snapshot ID changes). Adding a song from the web, Slack, or MCP appends it to that playlist.
- **Up next panel**: shows the next 3 spins in room order — DJ name, track, artist, and album thumbnail from Spotify.
- **Why not Spotify's own play queue**: each listener's Spotify queue is personal to their device. Using it would let listeners drift apart, so the server starts each track by URI on every speaker instead.
- **Check in Phase 1**: confirm that playlist read and write endpoints are open to development-mode apps. If writes are blocked, fall back to Spinroom-side sets stored in `crate_items`, with read-only playlist import.

### Spotify platform access and policy (checked October 2026)

Spotify's 2025 and 2026 rule changes make platform access, not engineering, the deciding constraint. They force a distribution choice before Phase 1.

- **Development mode** is the default for every new app: the app owner needs Premium, and each Client ID allows only 5 allowlisted users. One developer account can hold up to 25 Client IDs, but they share a single API quota; quota errors return 429 with reason `QUOTA_EXCEEDED`. ([Spotify, Jul 2026](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates), [summary](https://vorplabs.com/agent-tools/spotify-api-changes))
- **Extended quota** (no user cap) accepts only registered organizations with a live service of at least 250,000 monthly active users — out of reach for a new product. ([source](https://vorplabs.com/agent-tools/spotify-cli))
- **Commercial use**: the Web Playback SDK may not be used in commercial projects without Spotify's prior written approval, and music streaming may only be offered to Premium subscribers. Mobile-only Premium plans cannot use the SDK. ([Web Playback SDK docs](https://developer.spotify.com/documentation/web-playback-sdk))

**Distribution decision: option B (decided October 7, 2026)**

| Option | How it works | Limit | Best for |
| --- | --- | --- | --- |
| A. One shared Spotify app | Owner registers one app and allowlists friends | 5 Spotify-connected users in total | Development and a friends-only room |
| B. Bring your own Spotify app (recommended) | Each user creates their own Spotify developer app and pastes its Client ID into Spinroom; login runs PKCE with that Client ID | No shared cap; each user's quota is their own; about 5 minutes of setup per user | Developer-heavy audience (MCP users) |
| C. Extended quota | Apply as a registered organization | 250,000 MAU required | Not reachable at launch |

Spinroom is built for option B. Option A stays as the local-development setup only. Each user brings their own Spotify Client ID; PKCE needs no client secret, so Spinroom never stores one.

**Option B setup flow (first run)**

1. User clicks "Connect Spotify" and lands on a guided setup screen with screenshots.
2. User opens the Spotify developer dashboard, creates an app, and selects Web API and Web Playback SDK.
3. User adds Spinroom's callback URL (`https://<domain>/v1/auth/spotify/callback`) as a redirect URI. The screen shows it with a copy button.
4. User pastes their Client ID into Spinroom. Spinroom validates the format, then starts PKCE login with that Client ID.
5. On success, Spinroom saves the Client ID on the user record and checks Premium.
6. If login fails, the screen names the likely cause (redirect URI mismatch, user not allowlisted, missing Premium) with the fix.

**Rules for option B**

- The Client ID is not a secret. Returning users on a new device re-enter it, or Spinroom remembers it in a long-lived cookie.
- A user can let up to 4 friends sign in through their Client ID by adding them to their Spotify app's allowlist. Spinroom supports this as "Join through a friend's app" for people who don't want to set up their own; those guests share the host's quota.
- Each user's API calls draw from their own developer quota. Spinroom handles `QUOTA_EXCEEDED` per user without affecting the room.
- Spinroom does not hold an app-level Spotify credential in production; all Spotify calls run with the acting user's token.

* Keep Spinroom strictly non-commercial: no ads, subscriptions, or paid features. Seek Spotify's written approval before any monetization.
* A shared office radio in a workplace Slack may conflict with Spotify's personal, non-commercial use terms. Get a policy read before promoting the Slack app for workplace use.

## Web app and 2D room

The room is a pixel-art nightclub stage in the **Pixel Neon DJ** design system: chibi DJs behind a booth, a yellow LED marquee showing the track, neon lights, and the crowd seen from behind. The pixel scene is the show; the player and the music queue are Spotify. The scene is built from layered art, sprites, and live text in plain DOM, CSS, and SVG — no canvas game engine, WebGL, or 3D.

### Visual design: Pixel Neon DJ

The reference image sets the target look. The scene must be rebuilt as live layers, not used as one flat picture, because names, the marquee, DJs, and the crowd all change in real time. Commit the design system file to the repo as `docs/design/pixel-neon-dj.md`; its prompt is used to generate the background art.

&#91;image: Pixel Neon DJ reference: three DJs at a booth with an LED marquee, crowd in front\]

**Scene layers, back to front**

| Layer | What it shows | Driven by |
| --- | --- | --- |
| Back wall and truss | Dark brick wall, lighting truss, 5 spotlights | Static art; beams sweep slowly; the active DJ's spotlight brightens |
| Speaker stacks | Left and right stacks with vertical LED strips | Static art; strips pulse to a synthetic beat loop |
| Equalizer bars | Rainbow meter bars behind the performers | Synthetic loop; web apps get no access to Spotify's audio signal |
| DJs and laptops | 1 to 3 DJs behind the booth, name label above each head, laptop in front | Booth slots; each DJ's avatar plays its DJing animation |
| Booth and LED marquee | Dark metal booth with speakers and a black LED marquee | Live Spotify metadata as "Artist – Title" in amber pixel type; elapsed time bottom-left, remaining bottom-right; long titles scroll like an LED sign |
| Dance floor and crowd | Reflective floor; one crowd figure per present member, seen from behind | Presence and votes: hands up on Hype, arms down and turning away on Skip |

**Rules for the scene**

- Native art resolution 480 × 270, scaled to fill the stage area at any window size with `image-rendering: pixelated` (nearest-neighbour; whole device-pixel scales preferred when they fit within 3%). No smoothing, gradients, or blur.
- Background plates (wall, truss, speakers, booth, floor) are generated with the design system prompt, then cleaned by hand: snapped to the palette, split into layers, and exported as WebP.
- Crowd figures are an original set of back-view sprites (hoodies, beanies, pigtails, small robot and hooded mascots), tinted with each member's color. A member's own avatar shows front-facing in their hover card, the member list, and when they DJ. Imported ChatGPT pets have no back view, so they are not used on the floor.
- Each booth slot has its own neon color (cyan, magenta, amber) shared by its spotlight and name label. Labels use a chunky pixel font with a dark outline.
- Laptop lids carry original Spinroom marks only. The Apple, Windows, and Linux-style marks in the reference image are not used.
- Album art is never pixelated or restyled; it appears unaltered in the Spotify player panel, outside the pixel scene.
- No strobe: nothing flashes more than 3 times per second. Reduced-motion mode freezes beams, bars, LED strips, and the crowd.

**Design tokens**

| Token | Hex | Use |
| --- | --- | --- |
| `--night` | #0B1026 | Page and scene background |
| `--indigo` | #1A1440 | Panels, booth shadow |
| `--violet` | #5B2DFF | Skyline and accent |
| `--magenta` | #FF2BD6 | Neon accent, slot 2 |
| `--pink` | #FF4FA3 | Hype highlights |
| `--cyan` | #3DE2FF | Neon accent, slot 1, focus rings |
| `--purple` | #7A4DFF | Secondary accent |
| `--amber` | #FFB000 | Marquee text, slot 3 |
| `--yellow` | #FFD24A | Marquee highlights |
| `--booth` | #2A3142 | Booth body, cards |
| `--charcoal` | #1C2230 | Crowd, floor, inputs |

Type: a chunky pixel sans for names and headings and a tall condensed pixel font for the marquee, both under open licenses (for example Pixelify Sans and VT323). Body text in panels uses a plain readable sans for accessibility. All UI text meets WCAG AA contrast against `--night` and `--indigo`.

### Screens

| Screen | Purpose |
| --- | --- |
| Landing | What Spinroom is, "Sign in with Spotify" with guided Client ID setup, public room directory |
| Lobby | My rooms, public rooms, create room, avatar picker |
| Room | The 2D scene, now-playing bar, vote buttons, chat, DJ queue, my crate |
| Speaker status | Inline banner in the room: off, starting, live, paused elsewhere, error |
| Room settings | Thresholds, booth size, turn limit, invites, roles, Slack link |
| Profile | Avatar studio (ChatGPT pet import), display name, DJ points, linked Slack and MCP connections |
| Connect agent | Shows the MCP install snippet and a one-time link code |

### Room scene layout

- Center: the Pixel Neon DJ stage, scaled to fill the available space as the window resizes.
- Below the stage: the **Spotify player panel** (see Spotify integration) with unaltered album art, title, artist, Spotify logo and "Open in Spotify" link, progress bar, local volume and mute, and large Hype and Skip buttons.
- Right rail: tabs for Up next (from Spotify, see below), Chat, DJ queue, and My set. On narrow screens the rail becomes a bottom sheet.
- Listeners cannot pause, seek, or skip the room's music; Spotify controls in the panel are limited to local volume and mute. DJs and moderators get a "Skip spin" action.
- Remote-only members show as dimmed crowd figures with a small headphone-off icon.

### Visual and performance budget

- Initial JavaScript under 300 KB gzipped, excluding the Spotify SDK. Background plates and built-in sprites under 400 KB total.
- Animate only transforms and opacity, and pause all scene animation when the tab is hidden; respect `prefers-reduced-motion` by freezing avatars.
- Render at 60 fps on a 2020-era laptop with 100 avatars; lazy-load the room directory.
- All built-in avatars, booth art, and icons are original assets commissioned or generated for Spinroom (see the IP section).

### Keyboard shortcuts

- `H` Hype, `S` Skip, `Q` join or leave DJ queue, `/` focus chat, `?` show shortcuts.

## MCP server for coding agents

The MCP server is a thin remote control over the public API, built to the open Model Context Protocol spec so any compliant agent — Claude, Codex, Grok, Cursor, and others — can use it without agent-specific code.

### Transport and auth

- Primary: a hosted remote MCP server at `https://mcp.<domain>/mcp` using Streamable HTTP and the MCP authorization spec (OAuth 2.1 with PKCE and dynamic client registration). The user signs in once with Spotify in a browser popup.
- Fallback: an npm package (`npx spinroom-mcp`) running over stdio, authenticated with a personal access token created on the Profile page, for clients without remote MCP or OAuth support.
- Tokens are scoped to the user and revocable from the Profile page. The MCP server never holds Spotify tokens.

### Tools

| Tool | Inputs | Returns |
| --- | --- | --- |
| `list_rooms` | `filter` (mine, public), `query` | Rooms with live listener counts |
| `join_room` | `room` (slug or invite link) | Room state + speaker URL if no live speaker |
| `leave_room` | `room` | Confirmation |
| `now_playing` | `room` | Track, DJ, progress, crowd score, booth, queue length |
| `vote` | `room`, `vote` (hype, skip, clear) | Updated crowd score |
| `search_tracks` | `query`, `limit` (default 5) | Tracks with URI, title, artist, duration |
| `crate_add` | `room`, `track_uri` or `query` | Updated crate |
| `crate_list` / `crate_remove` / `crate_move` | `room`, track or position | Updated crate |
| `dj_queue_join` / `dj_queue_leave` | `room` | Queue position or booth slot |
| `skip_my_spin` | `room` | Confirmation |
| `create_room` | `name`, `visibility`, settings | Room + invite link |
| `invite` | `room`, `expires_in` | Shareable invite link and a one-line message to paste |
| `chat_send` | `room`, `text` | Confirmation |
| `room_history` | `room`, `limit` | Recent spins with scores |

### Resources and prompts

- Resource `spinroom://room/{slug}/now-playing` so clients that support subscriptions can show live state.
- Prompt `spinroom_session`: "Join my usual room, start a speaker if needed, and tell me what's playing."

### Behaviour rules

- Every tool that needs audio context returns `speaker_status`. If no speaker is live, the response includes the speaker URL and a short instruction to open it.
- Tool responses are compact plain text plus structured JSON, so agents spend few tokens.
- Writes are idempotent where possible (`vote`, `join_room`), and every write is rate limited per user (20 per minute).
- Tool descriptions state clearly that votes and chat are visible to other room members.

## Slack app

The Slack app links a channel to a room and keeps one live now-playing card in that channel, so the team sees what's on and reacts without leaving Slack.

### Install and linking

- Distributed as a Slack app with OAuth install per workspace. Bot scopes: `commands`, `chat:write`, `chat:write.public`, `users:read`, `channels:read`, `groups:read`, `im:write`.
- `/spinroom link <room>` links the current channel to a room (owner or moderator only). One room per channel; a room can link to several channels.
- Each Slack user links their Spinroom account once through a "Connect Spinroom" button that opens a web login. Unlinked users can see the card but buttons prompt them to connect.
- Uses Slack's Events API and interactivity over HTTPS (Socket Mode allowed for local development only).

### The now-playing card

- One pinned-style message per linked channel, edited in place with `chat.update` on each change rather than posting new messages. A new card is posted only when the previous one scrolls far up (setting: after 50 newer messages).
- Block Kit layout: album art accessory; track title and artist; "DJ: \<name>" and booth avatars as small images; progress as text ("1:42 / 3:58"); crowd score ("Hype 6 · Skip 1").
- Buttons: Hype, Skip, Join DJ queue, Open speaker, Add to my set (opens a search modal).
- Card updates on spin start, spin end, booth change, and vote change. Vote updates are debounced to at most one edit every 3 s per channel to respect Slack rate limits.

### Slash commands

| Command | Action |
| --- | --- |
| `/spinroom link <room>` / `unlink` | Link or unlink this channel |
| `/spinroom now` | Post the card privately (ephemeral) |
| `/spinroom hype` / `skip` | Vote on the current spin |
| `/spinroom add <search>` | Search and add to my set via a modal |
| `/spinroom dj` / `/spinroom undj` | Join or leave the DJ queue |
| `/spinroom invite @user` | DM an invite link |
| `/spinroom speaker` | DM my speaker link |

### Optional extras (post-v1)

- App Home tab with my rooms, crate, and points.
- Daily recap message with the top-hyped spins.
- Set Slack status to the current track for users who opt in (needs a user token with `users.profile:write`).

## System architecture and tech stack

One API and one room engine sit at the center; the web app, MCP server, and Slack service are clients of it, and a future mobile app plugs in the same way.

&#91;embedded content: system architecture · 3 surfaces, 1 API\]

Only the web speaker tab touches Spotify playback; the API talks to Spotify only for login, token refresh, and search.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript everywhere | One contracts package shared by all apps |
| API | Node.js 22, Fastify, `ws` for WebSockets | Fast, simple, good WebSocket support |
| Validation and contracts | Zod schemas, OpenAPI generated from them | Single source of truth for every client |
| Database | Postgres 16 with Drizzle ORM and migrations | Relational data, typed queries |
| Live state and pub/sub | Redis 7 | Presence, votes, room locks, event fan-out across instances |
| Web app | Vite + React + TypeScript, CSS modules, SVG/sprite avatars | Lightweight, no game engine |
| Web state | TanStack Query for REST, small store for live room state | Simple, cache-friendly |
| MCP server | Official MCP TypeScript SDK, Streamable HTTP + stdio builds | Works across MCP clients |
| Slack app | Bolt for JavaScript (HTTP mode) | Official, handles signing and retries |
| Tests | Vitest, Playwright | Unit and end-to-end |
| Hosting | Containers on a managed platform; managed Postgres, Redis, and S3-compatible object storage with a CDN for avatars | Sticky WebSocket support and easy scaling |

Each app deploys separately so the MCP and Slack services can scale or fail without taking down the web room.

## Data model

Postgres holds durable records; Redis holds live room state (presence, current spin, votes) and is rebuilt from Postgres on restart. All IDs are UUIDv7; all times are UTC milliseconds.

| Table | Key fields | Notes |
| --- | --- | --- |
| `users` | id, spotify\_user\_id (unique), spotify\_client\_id, display\_name, avatar\_id, avatar\_color, is\_premium, created\_at | is\_premium refreshed on each login |
| `spotify_tokens` | user\_id, refresh\_token\_enc, access\_token\_enc, expires\_at, scopes | Encrypted at rest (KMS or libsodium sealed box) |
| `rooms` | id, slug (unique), name, description, owner\_id, visibility, settings\_json, created\_at | settings\_json holds all thresholds and limits |
| `room_members` | room\_id, user\_id, role, banned, set\_playlist\_id, set\_position, joined\_at, last\_seen\_at | role: owner, moderator, member |
| `invites` | id, room\_id, token\_hash, created\_by, expires\_at, revoked\_at, uses | Only the hash is stored |
| `crate_items` | id, room\_id, user\_id, track\_uri, title, artists, duration\_ms, art\_url, position | Cache of the linked playlist; also the fallback set if playlist writes are unavailable |
| `dj_queue` | room\_id, user\_id, position, joined\_at, cooldown\_until | Mirrored to Redis for live use |
| `booth_slots` | room\_id, slot, user\_id, consecutive\_skips, spins\_this\_turn | Max 3 rows per room |
| `spins` | id, room\_id, dj\_user\_id, track\_uri, title, artists, duration\_ms, started\_at, ended\_at, end\_reason, hype\_count, skip\_count, eligible\_voters | end\_reason: completed, auto\_skip, dj\_skip, mod\_skip, dj\_left |
| `votes` | spin\_id, user\_id, value, updated\_at, surface | surface: web, slack, mcp |
| `chat_messages` | id, room\_id, user\_id, text, created\_at | Keep 30 days |
| `slack_installs` | team\_id, bot\_token\_enc, installed\_by, installed\_at | One per workspace |
| `slack_links` | team\_id, channel\_id, room\_id, card\_message\_ts | Channel to room link and current card |
| `identity_links` | user\_id, provider (slack, mcp), external\_id, created\_at | Slack user ID, MCP OAuth client subject |
| `api_tokens` | id, user\_id, token\_hash, label, scopes, last\_used\_at, revoked\_at | Personal tokens for stdio MCP |
| `speakers` | id, user\_id, room\_id, spotify\_device\_id, status, last\_heartbeat\_at | Live speaker per member per room |

**Redis keys (per room)**: `room:{id}:state` (current spin, startedAtServerMs, booth), `room:{id}:presence` (sorted set by last heartbeat), `room:{id}:votes:{spinId}` (hash user → value), `room:{id}:lock` (single-writer lock for the room engine).

## Public API

One versioned API (`/v1`) serves every client: REST for commands and reads, a WebSocket for live events. The web app, MCP server, Slack app, and any future mobile app use exactly these endpoints — no client gets private shortcuts.

### REST endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /v1/auth/spotify/start`, `GET /v1/auth/spotify/callback` | Spotify login with PKCE |
| `POST /v1/auth/session/refresh`, `POST /v1/auth/logout` | Session handling |
| `GET /v1/me`, `PATCH /v1/me` | Profile, avatar |
| `GET /v1/me/spotify-token` | Short-lived access token, speaker pages only (origin-checked) |
| `GET /v1/rooms`, `POST /v1/rooms` | List and create rooms |
| `GET /v1/rooms/{slug}`, `PATCH /v1/rooms/{slug}` | Room snapshot, settings |
| `POST /v1/rooms/{slug}/join`, `POST /v1/rooms/{slug}/leave` | Membership and presence |
| `POST /v1/rooms/{slug}/invites`, `DELETE /v1/invites/{id}` | Create or revoke invites |
| `POST /v1/invites/{token}/accept` | Join via invite |
| `GET /v1/rooms/{slug}/crate`, `POST /v1/rooms/{slug}/crate`, `PATCH`/`DELETE /v1/rooms/{slug}/crate/{itemId}` | Crate management |
| `POST /v1/rooms/{slug}/crate/import` | Import a Spotify playlist |
| `POST /v1/rooms/{slug}/dj-queue`, `DELETE /v1/rooms/{slug}/dj-queue` | Join or leave DJ queue |
| `PUT /v1/rooms/{slug}/spins/{spinId}/vote` | Cast or change vote: `{"value":"hype"\|"skip"\|null}` |
| `POST /v1/rooms/{slug}/spins/current/skip` | DJ or moderator skip |
| `GET /v1/rooms/{slug}/history` | Recent spins |
| `POST /v1/rooms/{slug}/chat` | Send chat |
| `POST /v1/rooms/{slug}/moderation` | Kick, ban, mute |
| `GET /v1/search/tracks?q=` | Spotify search proxy |
| `POST /v1/speakers`, `POST /v1/speakers/{id}/heartbeat` | Register speaker, report position and drift |
| `GET /v1/time` | Server time for clock sync |
| `POST /v1/integrations/slack/*` | Slack events, interactivity, commands (signature-verified) |
| `POST /v1/tokens`, `DELETE /v1/tokens/{id}` | Personal API tokens |

All write endpoints accept an `Idempotency-Key` header. Errors use RFC 9457 problem JSON with stable `code` values (for example `not_premium`, `crate_empty`, `on_cooldown`, `speaker_missing`).

### Realtime events (WebSocket `/v1/rooms/{slug}/live`)

| Event | Payload highlights |
| --- | --- |
| `room.snapshot` | Full state on connect or reconnect |
| `presence.changed` | user, state (speaker, remote, away) |
| `booth.changed` | slots, active DJ |
| `dj_queue.changed` | ordered user list |
| `spin.started` | spin id, track, dj, startedAtServerMs, durationMs |
| `spin.ended` | spin id, reason, final hype and skip counts |
| `votes.changed` | hype, skip, eligible voters (aggregate only) |
| `dj.bounced` | user, cooldown until |
| `chat.message` | message |
| `room.settings_changed` | new settings |

Events carry a monotonically increasing `seq` per room. Clients that miss a `seq` request a fresh `room.snapshot`. The Slack and MCP services subscribe to the same event stream through an internal pub/sub channel.

## Non-functional requirements

The bar for v1 is small-scale but solid: up to 500 concurrent rooms and 5,000 concurrent members on modest infrastructure.

**Performance**

- API p95 under 150 ms for reads, under 250 ms for writes.
- Event fan-out to all clients in a room under 300 ms p95.
- Room engine is single-writer per room (Redis lock) to avoid race conditions on votes and transitions.

**Reliability**

- Server restarts must not stop a playing room: state is rebuilt from Redis and Postgres, and spin timers are rescheduled from `startedAtServerMs`.
- WebSocket clients reconnect with exponential backoff (1 s to 30 s) and resync via snapshot.
- Spotify API errors (429, 5xx) are retried with backoff; repeated failure for one listener shows an error only on that listener's speaker.

**Security**

- Spotify, Slack, and personal tokens encrypted at rest; invite and API tokens stored only as hashes.
- Session cookies `HttpOnly`, `Secure`, `SameSite=Lax`; CSRF protection on cookie-authenticated writes.
- Slack requests verified with the signing secret; MCP uses OAuth 2.1 with audience-bound tokens.
- Rate limits per user and per IP on all writes; chat text escaped and length-capped at 500 characters.
- Strict Content Security Policy that allows only the app's origin and Spotify SDK and image domains.

**Privacy**

- Store only what the features need: Spotify user ID, display name, email (for account recovery), and listening events inside Spinroom.
- Users can delete their account and all personal data from the Profile page; deletion completes within 30 days.
- Individual votes are private to moderators; aggregates are public to the room.

**Accessibility**

- WCAG 2.2 AA for all non-scene UI. Every action in the 2D scene is also reachable from the side panels and keyboard.
- Screen-reader live region announces track changes and vote outcomes.
- Colour is never the only signal for Hype or Skip.

**Observability**

- Structured logs with room and spin IDs; metrics for drift, join-to-audio time, event latency, and Spotify error rates; error tracking on web and server. Product analytics events (room created, joined, speaker started, Spotify setup abandoned, vote cast by surface, DJ turn taken) feed the success metrics.

## Originality and IP guardrails

Spinroom borrows the general idea of a shared DJ room — which no one owns — but nothing of Turntable.fm's specific expression. These rules are hard requirements for the build, not suggestions.

- No Turntable.fm names, logos, wordmarks, fonts, color schemes, sounds, or copy anywhere in the product, code comments, or marketing.
- No recreation of Turntable.fm's specific avatar characters (for example its signature animal and robot avatars), room art, booth layout, or UI screens. All built-in characters and scenes are original designs. User-uploaded avatars follow the custom avatar rules: rights confirmation at upload, reporting, and takedown.
- Use Spinroom's own vocabulary (Hype and Skip, crate, booth, bounce) instead of Turntable.fm's terms ("awesome", "lame", "DJ spot").
- Do not reference Turntable.fm screenshots, assets, or source code during design or build.
- Product name "Spinroom" is a working title. Run a trademark search before public launch and before buying a domain.
- Follow Spotify's branding guidelines: show the Spotify logo or attribution where Spotify content appears, link tracks back to Spotify, and never imply Spotify endorsement.
- Do not cache audio, record playback, or let users download tracks. Store only metadata needed to display spins.

## Future mobile readiness (plan only, do not build)

Mobile is out of scope for v1, but v1 must not block it. A future native app should be "just another client" of the same API, plus a native speaker.

**Decisions to make now**

- All game logic lives server-side behind `/v1`; the web app holds no rules that a mobile app would need to copy.
- Auth supports token-based sessions (bearer access token + refresh token) in addition to web cookies, so a native app can authenticate without a browser cookie jar.
- Shared TypeScript package (`@spinroom/contracts`) holds API types, event schemas (Zod), and error codes; a future React Native app reuses it.
- Avatar art is delivered as sprite sheets plus JSON metadata from the API, so any client can render the same characters.
- Realtime protocol is plain JSON over WebSocket with `seq` numbers — no web-only libraries in the protocol.
- A speaker is an abstract concept in the API (`POST /v1/speakers` with a `kind`), not tied to the Web Playback SDK.

**What a mobile build would add later**

- A native speaker using Spotify's iOS and Android SDKs, which control the installed Spotify app rather than playing audio in-app. Spotify lists mobile browsers as supported by the Web Playback SDK, but autoplay and background audio on phones are unreliable, so a mobile-web speaker must be tested before anyone relies on it.
- Push notifications for "your DJ turn is next" and "you were bounced".
- A simplified room view tuned for phones.

## Build plan for Claude Code

Build in six phases; each phase ends with its acceptance checks passing before the next starts. Claude Code should open each phase by restating its scope, and close it by running the checks and listing anything deferred.

**Working agreements for the build**

- Monorepo (pnpm workspaces): `apps/api`, `apps/web`, `apps/mcp`, `apps/slack`, `packages/contracts`, `packages/room-engine`.
- The room engine (rotation, voting, bounce, timing) is a pure TypeScript module with no I/O, fully unit-tested, and driven by injected clock and storage adapters.
- Every API endpoint and event is defined first in `packages/contracts`; clients import types from there.
- Docker Compose for local Postgres and Redis; `.env.example` lists every secret; seed script creates two rooms and three fake users.
- Tests: Vitest for units, Playwright for web flows, contract tests for the API. CI runs lint, type-check, and tests on every push.

**Phase 1 — Foundations**

- Monorepo, contracts package, API skeleton, Postgres schema and migrations, Redis wiring, guided per-user Spotify Client ID setup, Spotify login with Premium check.

* [ ] A user can log in with Spotify and see their profile; a Free account is refused at sign-in with an explanation; a new user finishes Client ID setup and first login in under 5 minutes.

**Phase 2 — Room engine**

- Rooms, membership, invites, crates, DJ queue, booth rotation, votes, auto-skip, bounce, history.

* [ ] Unit tests cover every FR-D and FR-V rule, including ties, DJ leaving mid-spin, empty booth, and cooldowns.
* [ ] A simulated room with 50 bots runs 100 spins without state errors.

**Phase 3 — Speaker and sync**

- Speaker page, Web Playback SDK, clock sync, drift correction, heartbeat, reclaim flow.

* [ ] Two real Premium accounts on two machines stay within 500 ms drift for 10 tracks.
* [ ] A late joiner starts at the correct position; a background tab keeps playing.

**Phase 4 — Web room UI**

- Lobby, Pixel Neon DJ stage (layered plates, LED marquee, booth DJs, back-view crowd), Spotify player panel and Up next, preset avatars, Avatar studio (ChatGPT pet import, validation, preview, safety check, reporting), voting, chat, DJ queue, set search and playlist linking, settings, moderation.

* [ ] Full Journey 1 and 2 pass in Playwright; bundle stays within budget; reduced-motion works; a real ChatGPT sprite kit and a single version 1 and version 2 sheet each import, preview, and animate in the room, and each invalid case returns its named error.

**Phase 5 — MCP server**

- Remote MCP with OAuth, stdio package with personal tokens, all tools, now-playing resource.

* [ ] Journey 3 works end to end in at least two different MCP clients (for example Claude and one other).

**Phase 6 — Slack app**

- Install flow, channel linking, account linking, live card, buttons, slash commands, debounced updates.

* [ ] Journey 4 works in a test workspace; a vote in Slack shows on the web within 1 s; the card never exceeds Slack rate limits under 20 votes in 10 s.

**Definition of done for v1**

- [ ] All six phases' checks pass in CI and in a staging deploy.
- [ ] Spotify policy review done and app submitted for broader access.
- [ ] Original avatar and room art in place; IP checklist reviewed.
- [ ] README covers local setup, env vars, Spotify app setup, Slack app manifest, and MCP install for each client.

## Risks, open questions, and assumptions

The biggest risk is Spotify platform access, not engineering; settle the distribution model before Phase 1.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Development mode caps each Spotify app at 5 users; extended quota needs 250,000 MAU | No public service on one Spotify app | Bring-your-own Client ID (option B); shared app only for development |
| Setup friction from option B | Low sign-up conversion, worst in Slack | Guided setup screen; measure drop-off in Phase 1 |
| SDK commercial-use restriction and personal-use terms | Workplace or monetized use may be non-compliant | Stay non-commercial; policy review before workplace Slack rollout |
| Spotify's own Jam feature already offers group listening | Weak differentiation | Lean on the DJ game, voting, avatars, and Slack and agent surfaces |
| API quota: one play call per listener per track, plus searches | `QUOTA_EXCEEDED` errors | Handle the 429 reason field; cache searches; option B splits quota per user |
| Premium-only listening | Smaller rooms | Remote-only mode for others; clear messaging at login |
| Browser background-tab throttling breaks drift correction | Out-of-sync audio | Server events, not client timers, drive track changes; measure in Phase 3 |
| Another app takes over a user's Spotify playback | Silent speaker | Device-lost detection and "Reclaim" flow |
| Slack rate limits on card edits | Stale or throttled cards | Debounce to one edit per 3 s per channel |
| MCP clients differ in auth support | Some agents cannot connect | Stdio fallback with personal tokens |

**Open questions**

- Final product name and domain.
- Keep Hype and Skip, or pick other original vote words closer to the old "awesome / lame" feel?
- Should Free Spotify users be allowed to DJ (picking tracks others hear) even if they cannot listen?
- Default auto-skip threshold: 50% of eligible voters, or a stricter two-thirds?
- Public room directory in v1, or invite-only rooms at launch?
- Hosting choice and budget (for example Fly.io or Render for API and WebSocket; managed Postgres and Redis).

**Assumptions**

- Web app only for v1; desktop Chrome, Edge, Firefox, and Safari latest two versions.
- Every listener has Spotify Premium; Slack and MCP users also have a speaker tab open to hear audio.
- Room sizes stay under 100 people present at once.

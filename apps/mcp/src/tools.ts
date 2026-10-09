import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spinElapsedMs, type Crate, type RoomSnapshot } from '@spinroom/contracts';
import { ApiError, LiveRoom, formatMs, type SpinroomClient, type WsLike } from '@spinroom/sdk';
import { z } from 'zod';

export interface SpinroomMcpDeps {
  client: SpinroomClient;
  /** Public web origin for speaker and invite links. */
  publicUrl: string;
  /** Opens a live socket to the API as this user (for resource subscriptions). */
  connectLive?: (url: string) => WsLike;
  /** API base for ws:// URLs (defaults to the client's base URL). */
  apiUrl?: string;
}

const VISIBLE = 'Votes and chat are visible to other room members (votes in aggregate).';

/** Accept a slug, a room URL (/r/slug) or an invite link (/invite/token). */
export function parseRoomArg(input: string): { slug?: string; invite?: string } {
  const s = input.trim();
  const inv = s.match(/\/invite\/(inv_[A-Za-z0-9_-]+)/) ?? s.match(/^(inv_[A-Za-z0-9_-]+)$/);
  if (inv) return { invite: inv[1]! };
  const room = s.match(/\/r\/([a-z0-9-]+)/i);
  if (room) return { slug: room[1]!.toLowerCase() };
  return { slug: s.toLowerCase().replace(/^#/, '') };
}

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function fail(e: unknown): CallToolResult {
  const msg = e instanceof ApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text', text: msg }], structuredContent: { error: e instanceof ApiError ? e.code : 'error', message: msg } };
}

async function safely(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

export function speakerInfo(snap: RoomSnapshot, publicUrl: string) {
  const status = snap.me?.speakerStatus ?? 'off';
  if (status === 'live') return { speaker_status: status };
  return {
    speaker_status: status,
    speaker_url: `${publicUrl}/r/${snap.room.slug}?speaker=1`,
    speaker_hint: 'No speaker is playing for you. Open the speaker link in a browser and click “Start speaker” to hear the room (Spotify Premium).',
  };
}

export function nowPlayingData(snap: RoomSnapshot, publicUrl: string) {
  const names = new Map(snap.members.map((m) => [m.user.id, m.user.displayName]));
  const spin = snap.currentSpin;
  const elapsed = spin ? Math.max(0, Math.min(spin.durationMs, spinElapsedMs(spin, snap.serverNow))) : 0;
  const up = snap.upNext[0];
  const myId = snap.me?.boothSlot !== null && snap.me?.boothSlot !== undefined ? (snap.booth.find((b) => b.slot === snap.me!.boothSlot)?.userId ?? null) : null;
  return {
    room: snap.room.slug,
    status: snap.status,
    track: spin
      ? { title: spin.track.title, artists: spin.track.artists, uri: spin.track.uri, url: `https://open.spotify.com/track/${spin.track.uri.split(':').pop()}` }
      : null,
    dj: spin ? (names.get(spin.djUserId) ?? 'DJ') : null,
    progress: spin ? { elapsed: formatMs(elapsed), duration: formatMs(spin.durationMs), elapsed_ms: elapsed, duration_ms: spin.durationMs } : null,
    crowd: { hype: snap.tally.hype, skip: snap.tally.skip, counted_listeners: snap.tally.eligibleVoters },
    my_vote: snap.me?.vote ?? null,
    booth: snap.booth.filter((b) => b.userId).map((b) => names.get(b.userId!) ?? 'DJ'),
    queue_length: snap.queue.length,
    up_next: snap.upNext.map((u) => ({ dj: names.get(u.djUserId) ?? 'DJ', track: u.track ? `${u.track.artists.join(', ')} – ${u.track.title}` : null })),
    // FR-L4: "up next" notice for MCP users.
    you_are_up_next: Boolean(myId && up?.djUserId === myId && spin?.djUserId !== myId),
    in_queue: snap.me?.inQueue ?? false,
    at_booth: snap.me?.boothSlot !== null && snap.me?.boothSlot !== undefined,
    ...speakerInfo(snap, publicUrl),
  };
}

function nowPlayingText(d: ReturnType<typeof nowPlayingData>): string {
  const lines: string[] = [];
  if (d.track) {
    lines.push(`▶ ${d.track.artists.join(', ')} – ${d.track.title} (DJ ${d.dj}) ${d.progress!.elapsed}/${d.progress!.duration}`);
    lines.push(`Hype ${d.crowd.hype} · Skip ${d.crowd.skip} · ${d.crowd.counted_listeners} listening${d.my_vote ? ` · you voted ${d.my_vote}` : ''}`);
  } else lines.push(d.status === 'paused' ? 'Paused — nobody has a speaker on.' : 'Booth open — nothing playing.');
  lines.push(`Booth: ${d.booth.join(', ') || 'empty'} · queue ${d.queue_length}`);
  if (d.up_next.length) lines.push(`Up next: ${d.up_next.map((u) => `${u.track ?? '?'} (${u.dj})`).join('; ')}`);
  if (d.you_are_up_next) lines.push('You’re up next!');
  if (d.speaker_status !== 'live' && 'speaker_url' in d) lines.push(`Speaker ${d.speaker_status}: open ${d.speaker_url} to listen.`);
  return lines.join('\n');
}

function crateText(c: Crate): string {
  if (!c.items.length) return 'Your set is empty. Add tracks with crate_add.';
  return c.items
    .map(
      (it, i) =>
        `${i + 1}. ${it.track.artists.join(', ')} – ${it.track.title}${i === c.position ? '  ← next' : ''}${it.flags.length ? ` [${it.flags.join(', ')}]` : ''}`,
    )
    .join('\n');
}

const crateData = (c: Crate) => ({
  mode: c.mode,
  playlist: c.playlist,
  next_position: c.position + 1,
  tracks: c.items.map((it, i) => ({ position: i + 1, title: it.track.title, artists: it.track.artists, uri: it.track.uri, flags: it.flags })),
  notice: c.notice,
});

/** Register every Spinroom tool, the now-playing resource and the session prompt. */
export function createSpinroomServer(deps: SpinroomMcpDeps) {
  const { client, publicUrl } = deps;
  const server = new McpServer(
    { name: 'spinroom', version: '1.0.0' },
    {
      capabilities: { resources: { subscribe: true, listChanged: false }, tools: {}, prompts: {} },
      instructions:
        'Spinroom is a shared music room on Spotify. Use join_room first, then now_playing, vote, crate_add and the DJ queue tools. Audio plays only in a browser speaker tab; if speaker_status is not "live", give the user the speaker_url. ' +
        VISIBLE,
    },
  );

  async function resolve(room: string): Promise<string> {
    const r = parseRoomArg(room);
    if (r.invite) {
      const p = await client.call('invites.preview', { params: { token: r.invite } });
      await client.call('rooms.join', { params: { slug: p.room.slug }, body: { invite: r.invite } });
      return p.room.slug;
    }
    return r.slug!;
  }
  const roomArg = z.string().min(1).describe('Room slug, room URL, or invite link');

  server.registerTool(
    'list_rooms',
    {
      title: 'List rooms',
      description: 'List your rooms or the public directory, with live listener counts and what is playing.',
      inputSchema: { filter: z.enum(['mine', 'public']).default('mine'), query: z.string().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ filter, query }) =>
      safely(async () => {
        const r = await client.call('rooms.list', { query: { filter, ...(query ? { q: query } : {}), limit: 25 } });
        const rooms = r.rooms.map((x) => ({
          slug: x.slug,
          name: x.name,
          listeners: x.listeners,
          listening: x.liveSpeakers,
          status: x.status,
          now_playing: x.nowPlaying ? `${x.nowPlaying.artists.join(', ')} – ${x.nowPlaying.title}` : null,
          role: x.myRole,
        }));
        const text = rooms.length
          ? rooms.map((x) => `${x.slug} — ${x.name} · ${x.listeners} here${x.now_playing ? ` · ♪ ${x.now_playing}` : ''}`).join('\n')
          : 'No rooms found.';
        return ok(text, { rooms });
      }),
  );

  server.registerTool(
    'join_room',
    {
      title: 'Join a room',
      description:
        'Join a room by slug or invite link (idempotent). Marks you present as a remote for 15 minutes. Returns room state and a speaker link if no speaker is playing for you.',
      inputSchema: { room: roomArg },
      annotations: { idempotentHint: true },
    },
    ({ room }) =>
      safely(async () => {
        const slug = await resolve(room);
        const snap = await client.call('rooms.join', { params: { slug }, body: {} });
        const d = nowPlayingData(snap, publicUrl);
        return ok(`Joined ${snap.room.name} (${slug}).\n${nowPlayingText(d)}`, { ...d, room: { slug, name: snap.room.name, members: snap.members.length } });
      }),
  );

  server.registerTool(
    'leave_room',
    { title: 'Leave a room', description: 'Leave a room: drops your presence, booth slot and DJ queue place.', inputSchema: { room: roomArg } },
    ({ room }) =>
      safely(async () => {
        const slug = await resolve(room);
        await client.call('rooms.leave', { params: { slug } });
        return ok(`Left ${slug}.`, { ok: true, room: slug });
      }),
  );

  server.registerTool(
    'now_playing',
    {
      title: 'Now playing',
      description: 'What is playing in a room: track, DJ, progress, crowd score (Hype/Skip), booth, queue length, up next, and whether you are up next.',
      inputSchema: { room: roomArg },
      annotations: { readOnlyHint: true },
    },
    ({ room }) =>
      safely(async () => {
        const slug = await resolve(room);
        const snap = await client.call('rooms.get', { params: { slug } });
        const d = nowPlayingData(snap, publicUrl);
        return ok(nowPlayingText(d), d);
      }),
  );

  server.registerTool(
    'vote',
    {
      title: 'Vote on the current spin',
      description: `Vote Hype or Skip on the current track, or clear your vote (idempotent). Votes from agents count toward auto-skip only while your speaker is live. ${VISIBLE}`,
      inputSchema: { room: roomArg, vote: z.enum(['hype', 'skip', 'clear']) },
      annotations: { idempotentHint: true },
    },
    ({ room, vote }) =>
      safely(async () => {
        const slug = await resolve(room);
        const r = await client.call('spins.vote', { params: { slug, spinId: 'current' }, body: { value: vote === 'clear' ? null : vote } });
        const note = r.counted ? '' : ' (recorded; it counts toward auto-skip once your speaker is live)';
        return ok(`${vote === 'clear' ? 'Vote cleared' : `Voted ${vote}`}${note}. Hype ${r.tally.hype} · Skip ${r.tally.skip}.`, {
          my_vote: r.myVote,
          counted: r.counted,
          crowd: r.tally,
        });
      }),
  );

  server.registerTool(
    'search_tracks',
    {
      title: 'Search Spotify tracks',
      description: 'Search Spotify for tracks. Returns URIs to use with crate_add.',
      inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(10).default(5) },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      safely(async () => {
        const tracks = await client.call('search.tracks', { query: { q: query, limit } });
        const list = tracks.map((t) => ({
          uri: t.uri,
          title: t.title,
          artist: t.artists.join(', '),
          duration: formatMs(t.durationMs),
          explicit: t.explicit,
          playable: t.playable,
        }));
        return ok(list.length ? list.map((t, i) => `${i + 1}. ${t.artist} – ${t.title} (${t.duration}) ${t.uri}`).join('\n') : 'No matches.', { tracks: list });
      }),
  );

  server.registerTool(
    'crate_add',
    {
      title: 'Add to my set',
      description:
        'Add a track to your set (crate) in a room, by Spotify track URI/link or by search query (first match). Appends to your linked Spotify playlist.',
      inputSchema: { room: roomArg, track_uri: z.string().optional(), query: z.string().max(200).optional() },
    },
    ({ room, track_uri, query }) =>
      safely(async () => {
        if (!track_uri && !query) throw new Error('Give track_uri or query');
        const slug = await resolve(room);
        const c = await client.call('crate.add', { params: { slug }, body: { ...(track_uri ? { trackUri: track_uri } : {}), ...(query ? { query } : {}) } });
        const last = c.items.at(-1);
        return ok(`Added ${last ? `${last.track.artists.join(', ')} – ${last.track.title}` : 'track'}. Your set:\n${crateText(c)}`, crateData(c));
      }),
  );

  server.registerTool(
    'crate_list',
    {
      title: 'List my set',
      description: 'Show your set (crate) for a room in play order.',
      inputSchema: { room: roomArg },
      annotations: { readOnlyHint: true },
    },
    ({ room }) =>
      safely(async () => {
        const slug = await resolve(room);
        const c = await client.call('crate.get', { params: { slug } });
        return ok(crateText(c), crateData(c));
      }),
  );

  server.registerTool(
    'crate_remove',
    {
      title: 'Remove from my set',
      description: 'Remove a track from your set by 1-based position or track URI.',
      inputSchema: { room: roomArg, position: z.number().int().min(1).optional(), track_uri: z.string().optional() },
    },
    ({ room, position, track_uri }) =>
      safely(async () => {
        const slug = await resolve(room);
        const c = await client.call('crate.get', { params: { slug } });
        const item = position ? c.items[position - 1] : c.items.find((i) => i.track.uri === track_uri);
        if (!item) throw new Error('No such track in your set');
        const next = await client.call('crate.remove', { params: { slug, itemId: item.id } });
        return ok(`Removed ${item.track.title}.\n${crateText(next)}`, crateData(next));
      }),
  );

  server.registerTool(
    'crate_move',
    {
      title: 'Reorder my set',
      description: 'Move a track in your set from one 1-based position to another.',
      inputSchema: { room: roomArg, from: z.number().int().min(1), to: z.number().int().min(1) },
    },
    ({ room, from, to }) =>
      safely(async () => {
        const slug = await resolve(room);
        const c = await client.call('crate.get', { params: { slug } });
        const item = c.items[from - 1];
        if (!item) throw new Error('No track at that position');
        const next = await client.call('crate.move', { params: { slug, itemId: item.id }, body: { position: to - 1 } });
        return ok(crateText(next), crateData(next));
      }),
  );

  server.registerTool(
    'dj_queue_join',
    {
      title: 'Join the DJ queue',
      description: 'Join the DJ queue (needs at least one playable track in your set and Spotify Premium). Returns your booth slot or queue position.',
      inputSchema: { room: roomArg },
    },
    ({ room }) =>
      safely(async () => {
        const slug = await resolve(room);
        const r = await client.call('djQueue.join', { params: { slug } });
        const text = r.boothSlot !== null ? `You’re at the booth (slot ${r.boothSlot + 1}).` : `You’re #${r.queuePosition} in the DJ queue.`;
        return ok(text, { booth_slot: r.boothSlot === null ? null : r.boothSlot + 1, queue_position: r.queuePosition });
      }),
  );

  server.registerTool(
    'dj_queue_leave',
    { title: 'Leave the DJ queue', description: 'Leave the DJ queue or step down from the booth.', inputSchema: { room: roomArg } },
    ({ room }) =>
      safely(async () => {
        const slug = await resolve(room);
        await client.call('djQueue.leave', { params: { slug } });
        return ok('You left the DJ queue / booth.', { ok: true });
      }),
  );

  server.registerTool(
    'skip_my_spin',
    { title: 'Skip my spin', description: 'Skip the track you are currently playing as DJ.', inputSchema: { room: roomArg } },
    ({ room }) =>
      safely(async () => {
        const slug = await resolve(room);
        await client.call('spins.skip', { params: { slug } });
        return ok('Skipped.', { ok: true });
      }),
  );

  server.registerTool(
    'create_room',
    {
      title: 'Create a room',
      description: 'Create a room. Returns the room and an invite link.',
      inputSchema: {
        name: z.string().min(2).max(60),
        visibility: z.enum(['public', 'invite_only']).default('public'),
        description: z.string().max(280).optional(),
        skip_ratio: z.number().min(0.1).max(1).optional().describe('Auto-skip when Skip votes reach this share of listeners (default 0.5)'),
        booth_slots: z.number().int().min(1).max(3).optional(),
      },
    },
    ({ name, visibility, description, skip_ratio, booth_slots }) =>
      safely(async () => {
        const r = await client.call('rooms.create', {
          body: {
            name,
            visibility,
            ...(description ? { description } : {}),
            settings: { ...(skip_ratio ? { skipRatio: skip_ratio } : {}), ...(booth_slots ? { boothSlots: booth_slots } : {}) },
          },
        });
        return ok(`Created ${r.room.name} (${r.room.slug}). Invite: ${r.invite.url}\nRoom: ${publicUrl}/r/${r.room.slug}`, {
          room: { slug: r.room.slug, name: r.room.name, visibility: r.room.visibility, url: `${publicUrl}/r/${r.room.slug}` },
          invite_url: r.invite.url,
          message: r.invite.message,
        });
      }),
  );

  server.registerTool(
    'invite',
    {
      title: 'Invite someone',
      description: 'Create a shareable invite link and a one-line message to paste.',
      inputSchema: { room: roomArg, expires_in: z.enum(['1h', '1d', '7d', '30d', 'never']).default('7d') },
    },
    ({ room, expires_in }) =>
      safely(async () => {
        const slug = await resolve(room);
        const ms = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, never: null }[expires_in];
        const inv = await client.call('invites.create', { params: { slug }, body: { expiresInMs: ms } });
        return ok(inv.message, { invite_url: inv.url, message: inv.message, expires_at: inv.expiresAt ? new Date(inv.expiresAt).toISOString() : null });
      }),
  );

  server.registerTool(
    'chat_send',
    { title: 'Send chat', description: `Send a chat message to the room. ${VISIBLE}`, inputSchema: { room: roomArg, text: z.string().min(1).max(500) } },
    ({ room, text }) =>
      safely(async () => {
        const slug = await resolve(room);
        await client.call('chat.send', { params: { slug }, body: { text } });
        return ok('Sent.', { ok: true });
      }),
  );

  server.registerTool(
    'room_history',
    {
      title: 'Room history',
      description: 'Recent spins with their Hype/Skip scores.',
      inputSchema: { room: roomArg, limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true },
    },
    ({ room, limit }) =>
      safely(async () => {
        const slug = await resolve(room);
        const h = await client.call('rooms.history', { params: { slug }, query: { limit } });
        const spins = h.map((s) => ({
          title: s.track.title,
          artists: s.track.artists,
          dj: s.djName,
          hype: s.hype,
          skip: s.skip,
          ended: s.endReason ?? 'playing',
          at: new Date(s.startedAtServerMs).toISOString(),
        }));
        return ok(
          spins.map((s) => `${s.artists.join(', ')} – ${s.title} · DJ ${s.dj} · Hype ${s.hype} Skip ${s.skip} · ${s.ended}`).join('\n') || 'No spins yet.',
          { spins },
        );
      }),
  );

  // ---------------------------------------------------------------- resource
  const template = new ResourceTemplate('spinroom://room/{slug}/now-playing', {
    list: async () => {
      const r = await client.call('rooms.list', { query: { filter: 'mine', limit: 50 } }).catch(() => ({ rooms: [] }));
      return {
        resources: r.rooms.map((x) => ({ uri: `spinroom://room/${x.slug}/now-playing`, name: `${x.name} — now playing`, mimeType: 'application/json' })),
      };
    },
  });
  server.registerResource(
    'now-playing',
    template,
    { title: 'Now playing', description: 'Live now-playing state of a room. Subscribe for updates.', mimeType: 'application/json' },
    async (uri, vars) => {
      const slug = String(vars.slug);
      const snap = await client.call('rooms.get', { params: { slug } });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(nowPlayingData(snap, publicUrl)) }] };
    },
  );

  // Subscriptions: a live socket per subscribed room pushes resources/updated.
  const subs = new Map<string, LiveRoom>();
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    const m = uri.match(/^spinroom:\/\/room\/([a-z0-9-]+)\/now-playing$/);
    if (!m || !deps.connectLive || subs.has(uri)) return {};
    const base = (deps.apiUrl ?? client.baseUrl).replace(/^http/, 'ws');
    const live = new LiveRoom({
      url: `${base}/v1/rooms/${m[1]}/live`,
      connect: deps.connectLive,
      onEvent: (e) => {
        if (['spin.started', 'spin.ended', 'votes.changed', 'booth.changed', 'dj_queue.changed', 'room.status_changed'].includes(e.type)) {
          void server.server.sendResourceUpdated({ uri }).catch(() => {});
        }
      },
    });
    subs.set(uri, live);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subs.get(req.params.uri)?.close();
    subs.delete(req.params.uri);
    return {};
  });

  // ---------------------------------------------------------------- prompt
  server.registerPrompt(
    'spinroom_session',
    {
      title: 'Spinroom session',
      description: 'Join your usual room, start a speaker if needed, and say what’s playing.',
      argsSchema: { room: z.string().optional().describe('Room slug or invite link (defaults to your most recent room)') },
    },
    ({ room }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Join my usual Spinroom room${room ? ` (${room})` : ' (use list_rooms with filter "mine" and pick the first)'}, start a speaker if needed (give me the speaker link if speaker_status isn’t live), and tell me what’s playing.`,
          },
        },
      ],
    }),
  );

  return {
    server,
    close() {
      for (const l of subs.values()) l.close();
      subs.clear();
    },
  };
}

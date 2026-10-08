import { App, HTTPReceiver, LogLevel, webApi, type types, type RespondFn } from '@slack/bolt';
import type { RoomEvent } from '@spinroom/contracts';
import { createAesSealer, slackJoinSignature, tables, type Db } from '@spinroom/db';
import { eq } from 'drizzle-orm';
import { ApiError, formatMs, type SpinroomClient } from '@spinroom/sdk';
import type { Redis } from 'ioredis';
import { buildCard, connectBlocks, esc, joinButtonMessage, type Block } from './card.js';

type WebClient = webApi.WebClient;
const kb = (b: Block[]) => b as unknown as types.KnownBlock[];
import { CardScheduler, isCardEvent, subscribeRoomEvents } from './cardSync.js';
import { BASE, BOT_SCOPES, type SlackConfig } from './config.js';
import { createSpinroomAccess } from './spinroom.js';
import { botToken, createInstallationStore, createLinkStore } from './store.js';

const HELP = [
  '*Spinroom* — shared music rooms on Spotify',
  '`/spinroom link <room>` · `/spinroom unlink` — link this channel to a room (owners and moderators)',
  '`/spinroom now` — show the card just to you',
  '`/spinroom hype` · `/spinroom skip` — vote on the current spin',
  '`/spinroom add <search>` — add a song to your set',
  '`/spinroom dj` · `/spinroom undj` — join or leave the DJ queue',
  '`/spinroom invite @user` — DM someone an invite link',
  '`/spinroom button [room]` — post a “Join room” button anyone in this channel can click',
  '`/spinroom speaker` — DM yourself the speaker link (listening happens in a browser tab)',
].join('\n');

export interface SlackDeps {
  db: Db;
  redis: Redis;
  sub: Redis;
}

/** The Spinroom Slack app: Bolt in HTTP mode, routes under /v1/integrations/slack/*. */
export function createSlackApp(cfg: SlackConfig, deps: SlackDeps) {
  const sealer = createAesSealer(cfg.encryptionKey);
  const installationStore = createInstallationStore(deps.db, sealer);
  const links = createLinkStore(deps.db);
  const access = createSpinroomAccess(cfg);

  const receiver = new HTTPReceiver({
    signingSecret: cfg.signingSecret,
    endpoints: [`${BASE}/events`, `${BASE}/interactivity`, `${BASE}/commands`, `${BASE}/options`],
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    stateSecret: cfg.stateSecret,
    scopes: BOT_SCOPES,
    installationStore,
    installerOptions: { installPath: `${BASE}/install`, redirectUriPath: `${BASE}/oauth`, directInstall: true },
    customRoutes: [{ path: '/healthz', method: ['GET'], handler: (_req, res) => void res.writeHead(200).end('ok') }],
    unhandledRequestTimeoutMillis: 3001,
  });
  const app = new App({
    receiver,
    installationStore,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    stateSecret: cfg.stateSecret,
    scopes: BOT_SCOPES,
    logLevel: LogLevel.WARN,
    ...(cfg.slackApiUrl ? { clientOptions: { slackApiUrl: cfg.slackApiUrl } } : {}),
  });

  async function clientFor(teamId: string): Promise<WebClient> {
    const token = await botToken(deps.db, sealer, teamId);
    if (!token) throw new Error(`No install for ${teamId}`);
    return new webApi.WebClient(token, cfg.slackApiUrl ? { slackApiUrl: cfg.slackApiUrl } : {});
  }

  /** Resolve the acting user or reply with a Connect button. */
  async function actor(teamId: string, slackUserId: string, respond: RespondFn) {
    const a = await access.client(teamId, slackUserId);
    if (!a) {
      await respond({
        response_type: 'ephemeral',
        text: 'Connect your Spinroom account first.',
        blocks: kb(connectBlocks(access.connectUrl(teamId, slackUserId))),
      });
      return null;
    }
    void links.touchSurface(teamId, slackUserId).catch(() => {});
    return a;
  }

  async function roomFor(teamId: string, channelId: string, arg: string | undefined): Promise<string | null> {
    if (arg)
      return arg
        .toLowerCase()
        .replace(/^.*\/r\//, '')
        .split(/[?#]/)[0]!;
    const l = await links.forChannel(teamId, channelId);
    if (!l) return null;
    return (await slugOf(l.roomId)) ?? null;
  }

  const slugCache = new Map<string, string>();
  async function slugOf(roomId: string): Promise<string | null> {
    const hit = slugCache.get(roomId);
    if (hit) return hit;
    const row = await deps.db.query.rooms.findFirst({ where: eq(tables.rooms.id, roomId) });
    if (row) slugCache.set(roomId, row.slug);
    return row?.slug ?? null;
  }

  const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong — try again.');

  // ---------------------------------------------------------------- card sync
  /**
   * The "Join room" link for a channel linked to a room: signed so the people in the channel can
   * get into the room even when it's invite-only (only while the channel stays linked).
   */
  function channelJoinUrl(slug: string, roomId: string, teamId: string, channelId: string) {
    const sig = slackJoinSignature(cfg.serviceSecret, { teamId, channelId, roomId });
    const q = new URLSearchParams({ speaker: '1', via: 'slack', team: teamId, channel: channelId, sig });
    return `${cfg.publicUrl}/r/${slug}?${q.toString()}`;
  }

  async function renderCard(teamId: string, channelId: string, opts: { repost?: boolean } = {}) {
    const link = await links.forChannel(teamId, channelId);
    if (!link?.linkedBySlackUser) return;
    const slug = await slugOf(link.roomId);
    const a = slug ? await access.client(teamId, link.linkedBySlackUser) : null;
    if (!a || !slug) return;
    const snap = await a.client.call('rooms.get', { params: { slug } });
    const card = buildCard(snap, cfg.publicUrl, { joinUrl: channelJoinUrl(slug, link.roomId, teamId, channelId) });
    const client = await clientFor(teamId);
    if (link.cardMessageTs && !opts.repost && link.messagesSinceCard < snap.room.settings.slackRepostAfter) {
      await client.chat.update({ channel: channelId, ts: link.cardMessageTs, text: card.text, blocks: kb(card.blocks) });
      return;
    }
    const posted = await client.chat.postMessage({ channel: channelId, text: card.text, blocks: kb(card.blocks), unfurl_links: false });
    if (posted.ts) await links.setCard(teamId, channelId, posted.ts);
  }
  const cards = new CardScheduler(cfg.cardIntervalMs, async (key) => {
    const [teamId, channelId] = key.split(':') as [string, string];
    await renderCard(teamId, channelId).catch((e) => app.logger.warn('card update failed', e));
  });

  async function onRoomEvent(roomId: string, ev: RoomEvent) {
    if (isCardEvent(ev)) {
      for (const l of await links.forRoom(roomId)) cards.request(`${l.teamId}:${l.channelId}`);
    }
    // FR-L4: "up next" notice by DM for members who use Spinroom from Slack.
    if (ev.type === 'user.notice' && (ev.kind === 'up_next' || ev.kind === 'bounced' || ev.kind === 'crate_ran_out')) {
      for (const idn of await links.slackIdentities(ev.userId)) {
        if (!idn.lastSurfaceAt || Date.now() - idn.lastSurfaceAt > 15 * 60_000) continue;
        const client = await clientFor(idn.teamId).catch(() => null);
        if (!client) continue;
        const im = await client.conversations.open({ users: idn.externalId });
        if (im.channel?.id) await client.chat.postMessage({ channel: im.channel.id, text: ev.message });
      }
    }
  }

  // ---------------------------------------------------------------- slash command
  app.command('/spinroom', async ({ command, ack, respond, client }) => {
    await ack();
    const [sub = 'help', ...rest] = command.text.trim().split(/\s+/).filter(Boolean);
    const arg = rest.join(' ') || undefined;
    const team = command.team_id;
    const channel = command.channel_id;
    try {
      if (sub === 'help') return void (await respond({ response_type: 'ephemeral', text: HELP }));
      const a = await actor(team, command.user_id, respond);
      if (!a) return;
      const sr = a.client;

      if (sub === 'link') {
        if (!arg) return void (await respond({ response_type: 'ephemeral', text: 'Usage: `/spinroom link <room>`' }));
        const slug = await roomFor(team, channel, arg);
        const snap = await sr.call('rooms.join', { params: { slug: slug! }, body: {} });
        if (snap.me?.role !== 'owner' && snap.me?.role !== 'moderator') {
          return void (await respond({ response_type: 'ephemeral', text: 'Only the room’s owner or moderators can link a channel.' }));
        }
        await links.link({ teamId: team, channelId: channel, roomId: snap.room.id, linkedByUserId: a.userId, linkedBySlackUser: command.user_id });
        slugCache.set(snap.room.id, snap.room.slug);
        await renderCard(team, channel, { repost: true });
        return void (await respond({
          response_type: 'ephemeral',
          text: `Linked this channel to *${esc(snap.room.name)}*. The card updates as the room plays.`,
        }));
      }
      if (sub === 'unlink') {
        const l = await links.forChannel(team, channel);
        if (!l) return void (await respond({ response_type: 'ephemeral', text: 'This channel isn’t linked.' }));
        const snap = await sr.call('rooms.get', { params: { slug: (await slugOf(l.roomId))! } });
        if (snap.me?.role !== 'owner' && snap.me?.role !== 'moderator')
          return void (await respond({ response_type: 'ephemeral', text: 'Only owners and moderators can unlink.' }));
        await links.unlink(team, channel);
        return void (await respond({ response_type: 'ephemeral', text: 'Unlinked.' }));
      }

      const slug = await roomFor(team, channel, sub === 'add' || sub === 'invite' ? undefined : arg);
      if (!slug)
        return void (await respond({
          response_type: 'ephemeral',
          text: 'This channel isn’t linked to a room. Ask an owner to run `/spinroom link <room>`, or pass a room: `/spinroom now <room>`.',
        }));

      switch (sub) {
        case 'now': {
          const snap = await sr.call('rooms.join', { params: { slug }, body: {} });
          const link = await links.forChannel(team, channel);
          const joinUrl = link?.roomId === snap.room.id ? channelJoinUrl(slug, snap.room.id, team, channel) : undefined;
          const card = buildCard(snap, cfg.publicUrl, { ephemeral: true, joinUrl });
          return void (await respond({ response_type: 'ephemeral', text: card.text, blocks: kb(card.blocks) }));
        }
        case 'hype':
        case 'skip': {
          const r = await sr.call('spins.vote', { params: { slug, spinId: 'current' }, body: { value: sub } });
          const note = r.counted ? '' : ' It counts toward auto-skip once your speaker is live.';
          return void (await respond({
            response_type: 'ephemeral',
            text: `Voted ${sub === 'hype' ? '▲ Hype' : '▼ Skip'}. Hype ${r.tally.hype} · Skip ${r.tally.skip}.${note}`,
          }));
        }
        case 'add': {
          if (!arg) return void (await openAddModal(client, command.trigger_id, slug));
          const c = await sr.call('crate.add', { params: { slug }, body: { query: arg } });
          const t = c.items.at(-1)?.track;
          return void (await respond({
            response_type: 'ephemeral',
            text: t ? `Added *${esc(t.title)}* by ${esc(t.artists.join(', '))} to your set.` : 'Added.',
          }));
        }
        case 'dj': {
          const r = await sr.call('djQueue.join', { params: { slug } });
          return void (await respond({
            response_type: 'ephemeral',
            text: r.boothSlot !== null ? 'You’re at the booth — your track plays soon.' : `You’re #${r.queuePosition} in the DJ queue.`,
          }));
        }
        case 'undj':
          await sr.call('djQueue.leave', { params: { slug } });
          return void (await respond({ response_type: 'ephemeral', text: 'You left the DJ queue.' }));
        case 'invite': {
          const who = [...(arg ?? '').matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);
          if (!who.length) return void (await respond({ response_type: 'ephemeral', text: 'Usage: `/spinroom invite @someone`' }));
          const inv = await sr.call('invites.create', { params: { slug }, body: {} });
          for (const u of who) {
            const im = await client.conversations.open({ users: u });
            if (im.channel?.id) await client.chat.postMessage({ channel: im.channel.id, text: `<@${command.user_id}> invited you: ${inv.message}` });
          }
          return void (await respond({ response_type: 'ephemeral', text: `Invite sent to ${who.map((u) => `<@${u}>`).join(', ')}.` }));
        }
        case 'button': {
          // Linked channel: the signed channel link. Otherwise the room's own share link, which only
          // lets newcomers in if the room is public or has "Anyone with the link" turned on.
          const snap = await sr.call('rooms.join', { params: { slug }, body: {} });
          const link = await links.forChannel(team, channel);
          let joinUrl: string;
          if (link?.roomId === snap.room.id) joinUrl = channelJoinUrl(slug, snap.room.id, team, channel);
          else {
            const share = await sr.call('rooms.shareLink', { params: { slug } });
            if (snap.room.visibility === 'invite_only' && !share.linkSharing)
              return void (await respond({
                response_type: 'ephemeral',
                text: `*${esc(snap.room.name)}* is invite-only, so a button here would only work for people already in it. Link this channel first (\`/spinroom link ${slug}\`), or turn on *Anyone with the link* in the room’s Share menu.`,
              }));
            joinUrl = `${share.url}${share.url.includes('?') ? '&' : '?'}speaker=1`;
          }
          const msg = joinButtonMessage(snap.room, joinUrl);
          return void (await respond({ response_type: 'in_channel', text: msg.text, blocks: kb(msg.blocks) }));
        }
        case 'speaker': {
          const im = await client.conversations.open({ users: command.user_id });
          if (im.channel?.id)
            await client.chat.postMessage({
              channel: im.channel.id,
              text: `Your speaker for *${slug}*: ${cfg.publicUrl}/r/${slug}?speaker=1 — open it in a browser and click “Start speaker” (Spotify Premium).`,
            });
          return void (await respond({ response_type: 'ephemeral', text: 'I sent you your speaker link in a DM.' }));
        }
        default:
          return void (await respond({ response_type: 'ephemeral', text: HELP }));
      }
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: errText(e) });
    }
  });

  async function openAddModal(client: WebClient, triggerId: string, slug: string) {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'sr_add_modal',
        private_metadata: slug,
        title: { type: 'plain_text', text: 'Add to my set' },
        submit: { type: 'plain_text', text: 'Add' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'track',
            label: { type: 'plain_text', text: 'Search Spotify' },
            element: {
              type: 'external_select',
              action_id: 'sr_track_search',
              min_query_length: 2,
              placeholder: { type: 'plain_text', text: 'Song or artist' },
            },
          },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Results from Spotify. Added tracks go to the end of your set.' }] },
        ],
      },
    });
  }

  // ---------------------------------------------------------------- card buttons
  const vote =
    (value: 'hype' | 'skip') =>
    async ({
      ack,
      body,
      respond,
    }: {
      ack: () => Promise<void>;
      body: { team?: { id: string } | null; user: { id: string }; actions?: { value?: string }[] };
      respond: RespondFn;
    }) => {
      await ack();
      const team = body.team?.id ?? '';
      const slug = body.actions?.[0]?.value ?? '';
      const a = await actor(team, body.user.id, respond);
      if (!a) return;
      try {
        const r = await a.client.call('spins.vote', { params: { slug, spinId: 'current' }, body: { value } });
        await respond({
          response_type: 'ephemeral',
          replace_original: false,
          text: `${value === 'hype' ? '▲ Hype' : '▼ Skip'} counted${r.counted ? '' : ' (it counts toward auto-skip once your speaker is live)'}.`,
        });
      } catch (e) {
        await respond({ response_type: 'ephemeral', replace_original: false, text: errText(e) });
      }
    };
  app.action('sr_hype', vote('hype') as never);
  app.action('sr_skip', vote('skip') as never);
  app.action('sr_dj', async ({ ack, body, respond }) => {
    await ack();
    const b = body as { team?: { id: string } | null; user: { id: string }; actions?: { value?: string }[] };
    const a = await actor(b.team?.id ?? '', b.user.id, respond);
    if (!a) return;
    try {
      const r = await a.client.call('djQueue.join', { params: { slug: b.actions?.[0]?.value ?? '' } });
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: r.boothSlot !== null ? 'You’re at the booth.' : `You’re #${r.queuePosition} in the DJ queue.`,
      });
    } catch (e) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: errText(e) });
    }
  });
  app.action('sr_speaker', async ({ ack }) => ack());
  app.action('sr_connect', async ({ ack }) => ack());
  app.action('sr_add', async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as { team?: { id: string } | null; user: { id: string }; trigger_id: string; actions?: { value?: string }[] };
    const a = await actor(b.team?.id ?? '', b.user.id, respond);
    if (!a) return;
    await openAddModal(client as unknown as WebClient, b.trigger_id, b.actions?.[0]?.value ?? '');
  });

  app.options('sr_track_search', async ({ ack, body }) => {
    const b = body as { team?: { id: string } | null; user: { id: string }; value: string };
    const a = await access.client(b.team?.id ?? '', b.user.id);
    if (!a) return ack({ options: [] });
    try {
      const tracks = await a.client.call('search.tracks', { query: { q: b.value, limit: 10 } });
      await ack({
        options: tracks.map((t) => ({
          text: { type: 'plain_text' as const, text: `${t.artists.join(', ')} – ${t.title} (${formatMs(t.durationMs)})`.slice(0, 75) },
          value: t.uri,
        })),
      });
    } catch {
      await ack({ options: [] });
    }
  });

  app.view('sr_add_modal', async ({ ack, body, view, client }) => {
    const uri = view.state.values.track?.sr_track_search?.selected_option?.value;
    const slug = view.private_metadata;
    const a = await access.client(body.team?.id ?? '', body.user.id);
    if (!a || !uri) return void (await ack({ response_action: 'errors', errors: { track: 'Pick a track' } }));
    try {
      const c = await (a.client as SpinroomClient).call('crate.add', { params: { slug }, body: { trackUri: uri } });
      await ack();
      const t = c.items.at(-1)?.track;
      const im = await client.conversations.open({ users: body.user.id });
      if (im.channel?.id && t) await client.chat.postMessage({ channel: im.channel.id, text: `Added *${esc(t.title)}* to your set in ${slug}.` });
    } catch (e) {
      await ack({ response_action: 'errors', errors: { track: errText(e) } });
    }
  });

  // Count newer messages so the card is reposted after N of them.
  app.event('message', async ({ event, body }) => {
    const e = event as { channel?: string; subtype?: string; bot_id?: string };
    if (!e.channel || e.subtype || e.bot_id) return;
    const team = (body as { team_id?: string }).team_id ?? '';
    const n = await links.bumpMessages(team, e.channel);
    if (n !== null && n >= 50) await renderCard(team, e.channel, { repost: true }).catch(() => {});
  });

  app.event('app_uninstalled', async ({ body }) => {
    const team = (body as { team_id?: string }).team_id;
    if (team) await installationStore.deleteInstallation?.({ teamId: team, isEnterpriseInstall: false, enterpriseId: undefined });
  });

  return {
    app,
    receiver,
    cards,
    /** Node request listener for the Slack routes, for embedding in another HTTP server. */
    requestListener: receiver.requestListener,
    /** Follow room events without opening a port (embedded mode). */
    async attach() {
      await subscribeRoomEvents(deps.sub, (roomId, ev) => void onRoomEvent(roomId, ev).catch((e) => app.logger.warn('event handling failed', e)));
    },
    async start(port = cfg.port) {
      await this.attach();
      return app.start(port);
    },
    async stop() {
      cards.stop();
      await app.stop().catch(() => {});
    },
  };
}

import type { RoomSnapshot } from '@spinroom/contracts';
import { formatMs } from '@spinroom/sdk';

/* Block Kit types kept loose on purpose (they are plain JSON). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Block = Record<string, any>;

const abs = (publicUrl: string, url: string | null | undefined) => (!url ? null : url.startsWith('http') ? url : `${publicUrl}${url}`);
/** Slack mrkdwn escaping. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The live now-playing card for a linked channel. `joinUrl` is the room link behind its "Join room" button. */
export function buildCard(snap: RoomSnapshot, publicUrl: string, opts: { ephemeral?: boolean; joinUrl?: string } = {}): { text: string; blocks: Block[] } {
  const spin = snap.currentSpin;
  const names = new Map(snap.members.map((m) => [m.user.id, m.user]));
  const joinUrl = opts.joinUrl ?? `${publicUrl}/r/${snap.room.slug}?speaker=1`;
  const blocks: Block[] = [];
  let text: string;
  if (spin) {
    const dj = names.get(spin.djUserId);
    const elapsed = Math.max(0, Math.min(spin.durationMs, snap.serverNow - spin.startedAtServerMs));
    const trackUrl = `https://open.spotify.com/track/${spin.track.uri.split(':').pop()}`;
    text = `Now playing in ${snap.room.name}: ${spin.track.artists.join(', ')} – ${spin.track.title} (DJ ${dj?.displayName ?? 'DJ'})`;
    const art = abs(publicUrl, spin.track.artUrl);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${trackUrl}|${esc(spin.track.title)}>*\n${esc(spin.track.artists.join(', '))}\n_${esc(snap.room.name)}_`,
      },
      ...(art?.startsWith('https://')
        ? { accessory: { type: 'image', image_url: art, alt_text: `Album art for ${spin.track.album || spin.track.title}` } }
        : {}),
    });
    const thumbs = snap.booth
      .filter((b) => b.userId)
      .map((b) => names.get(b.userId!))
      .filter((u) => u && abs(publicUrl, u.avatar.thumbUrl)?.startsWith('https://'))
      .slice(0, 3)
      .map((u) => ({ type: 'image', image_url: abs(publicUrl, u!.avatar.thumbUrl)!, alt_text: u!.displayName }));
    blocks.push({
      type: 'context',
      elements: [
        ...thumbs,
        {
          type: 'mrkdwn',
          text: `DJ: *${esc(dj?.displayName ?? 'DJ')}* · ${formatMs(elapsed)} / ${formatMs(spin.durationMs)} · Hype ${snap.tally.hype} · Skip ${snap.tally.skip} · Listen on Spotify`,
        },
      ],
    });
  } else {
    text = `${snap.room.name}: ${snap.status === 'paused' ? 'paused — start a speaker to resume' : 'booth open — step up'}`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${esc(snap.room.name)}*\n${snap.status === 'paused' ? 'Paused — nobody has a speaker on.' : 'Booth open — step up and play something.'}`,
      },
    });
  }
  const slug = snap.room.slug;
  blocks.push({
    type: 'actions',
    block_id: `sr_actions:${slug}`,
    elements: [
      { type: 'button', action_id: 'sr_speaker', text: { type: 'plain_text', text: '🎧 Join room' }, style: 'primary', url: joinUrl, value: slug },
      { type: 'button', action_id: 'sr_hype', text: { type: 'plain_text', text: '▲ Hype' }, value: slug },
      { type: 'button', action_id: 'sr_skip', text: { type: 'plain_text', text: '▼ Skip' }, value: slug },
      { type: 'button', action_id: 'sr_dj', text: { type: 'plain_text', text: 'Join DJ queue' }, value: slug },
      { type: 'button', action_id: 'sr_add', text: { type: 'plain_text', text: 'Add to my set' }, value: slug },
    ],
  });
  if (opts.ephemeral) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Only you can see this.' }] });
  return { text, blocks };
}

/** A standalone "Join <room>" message for `/spinroom button`: post it, pin it, share it. */
export function joinButtonMessage(room: { name: string; description: string; slug: string }, joinUrl: string): { text: string; blocks: Block[] } {
  return {
    text: `Join ${room.name} on Spinroom`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*🎶 ${esc(room.name)}*${room.description ? `\n${esc(room.description)}` : ''}\nListen together and take turns DJing.` },
      },
      {
        type: 'actions',
        block_id: `sr_join:${room.slug}`,
        elements: [
          { type: 'button', action_id: 'sr_speaker', text: { type: 'plain_text', text: '🎧 Join room' }, style: 'primary', url: joinUrl, value: room.slug },
        ],
      },
    ],
  };
}

export function connectBlocks(url: string, why = 'Connect your Spinroom account to vote, DJ and add songs from Slack.'): Block[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: why } },
    { type: 'actions', elements: [{ type: 'button', action_id: 'sr_connect', text: { type: 'plain_text', text: 'Connect Spinroom' }, url, style: 'primary' }] },
  ];
}

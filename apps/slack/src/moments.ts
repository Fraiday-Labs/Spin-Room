import { esc } from './card.js';

/** A finished (or playing) spin, as the recap and moments need it. */
export interface SpinRow {
  djUserId: string;
  title: string;
  artists: string[];
  hype: number;
  skip: number;
}

const DAY = 86_400_000;
export const RECAP_WINDOW_MS = 7 * DAY;

/** "🎧 Pete stepped up…": a new DJ's first song. */
export function djMoment(djName: string, s: { title: string; artists: string[] }) {
  return `🎧 *${esc(djName)}* stepped up to the decks with *${esc(s.title)}* — ${esc(s.artists.join(', '))}`;
}

/** How a song ended, worth a line in the thread: the crowd skipped it, or loved it. Null if neither. */
export function endMoment(reason: string, s: SpinRow, djName: string): string | null {
  if (reason === 'auto_skip') return `😬 The crowd skipped *${esc(s.title)}* (${s.skip} ${s.skip === 1 ? 'skip' : 'skips'})`;
  if (s.hype >= 3 && s.hype >= 2 * s.skip) return `🔥 *${esc(s.title)}* got ${s.hype} hypes. Nice one, *${esc(djName)}*!`;
  return null;
}

/** Friday from 4 pm, in the channel's time zone, at most once every 5 days. */
export function isRecapTime(now: number, timeZone: string | null, lastRecapAt: number | null): boolean {
  if (lastRecapAt !== null && now - lastRecapAt < 5 * DAY) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone ?? 'UTC', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  }
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return weekday === 'Fri' && hour >= 16;
}

type Block = Record<string, unknown>;

/** The week in a room: songs and DJs, DJ of the week, the most-hyped songs. Null when nothing played. */
export function buildRecap(roomName: string, spins: SpinRow[], names: Map<string, string>, joinUrl: string): { text: string; blocks: Block[] } | null {
  if (!spins.length) return null;
  const name = (id: string) => esc(names.get(id) ?? 'Someone');
  const djs = new Map<string, { hype: number; songs: number }>();
  for (const s of spins) {
    const d = djs.get(s.djUserId) ?? { hype: 0, songs: 0 };
    d.hype += s.hype;
    d.songs++;
    djs.set(s.djUserId, d);
  }
  const [topDj, top] = [...djs.entries()].sort((a, b) => b[1].hype - a[1].hype || b[1].songs - a[1].songs)[0]!;
  const hyped = spins
    .filter((s) => s.hype > 0)
    .sort((a, b) => b.hype - a.hype || a.skip - b.skip)
    .slice(0, 3);
  const lines = [
    `*${spins.length}* ${spins.length === 1 ? 'song' : 'songs'} from *${djs.size}* ${djs.size === 1 ? 'DJ' : 'DJs'}`,
    `🏆 DJ of the week: *${name(topDj)}* — ${top.hype} ${top.hype === 1 ? 'hype' : 'hypes'} over ${top.songs} ${top.songs === 1 ? 'song' : 'songs'}`,
  ];
  if (hyped.length) {
    lines.push('🔥 Most hyped:');
    hyped.forEach((s, i) =>
      lines.push(`${i + 1}. *${esc(s.title)}* — ${esc(s.artists.join(', '))} · ${s.hype} ${s.hype === 1 ? 'hype' : 'hypes'} · DJ ${name(s.djUserId)}`),
    );
  }
  const title = `📊 This week in ${roomName}`;
  return {
    text: `${title}: ${spins.length} songs, DJ of the week ${names.get(topDj) ?? 'Someone'}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      {
        type: 'actions',
        elements: [{ type: 'button', action_id: 'sr_speaker', text: { type: 'plain_text', text: '🎧 Join room' }, style: 'primary', url: joinUrl }],
      },
    ],
  };
}

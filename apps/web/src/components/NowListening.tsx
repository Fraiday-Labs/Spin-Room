import { useSyncExternalStore } from 'react';
import { Link } from 'wouter';
import { SpeakerBanner } from '../room/SpeakerBanner';
import { listening } from '../speaker/session';
import type { SpeakerView } from '../speaker/types';
import { useMe } from '../lib/api';
import s from './NowListening.module.css';

const noop = () => () => {};
const OFF: SpeakerView = { status: 'off', message: null, driftMs: null, volume: 1, muted: false };

/** What this tab is listening to, and how its speaker is doing (off when nothing is). */
function useNowListening() {
  const now = useSyncExternalStore(listening.subscribe, listening.get);
  const c = now?.controller ?? null;
  const view = useSyncExternalStore(c ? (cb) => c.subscribe(cb) : noop, () => c?.view ?? OFF);
  return { now, c, view };
}

/**
 * Listening (or switching) to a room other than `slug`: its Listening ▾ button is showing, so
 * `slug` needs no Listen button of its own.
 */
export function useListeningElsewhere(slug: string) {
  const { now, view } = useNowListening();
  return !!now && now.slug !== slug && (view.status === 'live' || view.status === 'starting');
}

/**
 * The room you're listening to, on any page: its name (back to the room) and the same
 * Listening button as in the room (its menu switches rooms or stops). Hidden when nothing is playing, and in that room itself.
 * In another room's page, `here` is that room, always offered in the menu so you can switch to it.
 */
export function NowListening({ exceptSlug, here }: { exceptSlug?: string; here?: { slug: string; name: string } }) {
  const me = useMe();
  const { now, c, view } = useNowListening();
  if (!now || !c || now.slug === exceptSlug || view.status === 'off') return null;
  return (
    <div className={s.wrap} data-testid="now-listening">
      <Link href={`/r/${now.slug}`} className={s.room} title={`Back to ${now.roomName}`}>
        {now.roomName}
      </Link>
      <SpeakerBanner
        me={me.data ?? null}
        room={{ slug: now.slug, name: now.roomName }}
        here={here}
        view={view}
        onStart={() => void c.start()}
        onStop={() => void c.stop()}
        onReclaim={() => void c.reclaim()}
      />
    </div>
  );
}

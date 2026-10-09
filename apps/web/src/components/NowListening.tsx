import { useSyncExternalStore } from 'react';
import { Link } from 'wouter';
import { SpeakerBanner } from '../room/SpeakerBanner';
import { listening } from '../speaker/session';
import type { SpeakerView } from '../speaker/types';
import { useMe } from '../lib/api';
import s from './NowListening.module.css';

const noop = () => () => {};
const OFF: SpeakerView = { status: 'off', message: null, driftMs: null, volume: 1, muted: false };

/**
 * The room you're listening to, on any page: its name (back to the room) and the same
 * Listening / Stop button as in the room. Hidden when nothing is playing, and in that room itself.
 */
export function NowListening({ exceptSlug }: { exceptSlug?: string }) {
  const me = useMe();
  const now = useSyncExternalStore(listening.subscribe, listening.get);
  const c = now?.controller ?? null;
  const view = useSyncExternalStore(c ? (cb) => c.subscribe(cb) : noop, () => c?.view ?? OFF);
  if (!now || !c || now.slug === exceptSlug || view.status === 'off') return null;
  return (
    <div className={s.wrap} data-testid="now-listening">
      <Link href={`/r/${now.slug}`} className={s.room} title={`Back to ${now.roomName}`}>
        {now.roomName}
      </Link>
      <SpeakerBanner me={me.data ?? null} view={view} onStart={() => void c.start()} onStop={() => void c.stop()} onReclaim={() => void c.reclaim()} />
    </div>
  );
}

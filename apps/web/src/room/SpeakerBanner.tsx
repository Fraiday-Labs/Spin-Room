import type { Me } from '@spinroom/contracts';
import { useEffect, useState } from 'react';
import { LineIcon } from '../components/LineIcon';
import { ListeningMenu } from './ListeningMenu';
import type { SpeakerView } from '../speaker/types';
import s from './SpeakerBanner.module.css';

/**
 * Your speaker as one pill-shaped button that says what it will do:
 * Listen → Connecting… → Listening ▾ (switch rooms, or stop); "Play here" if Spotify moved to another
 * device; "Try again" (with the reason under it) after an error.
 */
export function SpeakerBanner(props: {
  me: Me | null;
  view: SpeakerView;
  /** The room this speaker plays (named in the Listening menu). */
  room: { slug: string; name: string };
  /** The room on screen, when it isn't `room`: listed in the menu too. */
  here?: { slug: string; name: string };
  onStart: () => void;
  onStop: () => void;
  onReclaim: () => void;
  autoFocus?: boolean;
}) {
  const { me, view } = props;
  // The reason it stopped shows for a few seconds under the button, then tucks away (still on hover).
  const [noteShown, setNoteShown] = useState(false);
  useEffect(() => {
    if (!view.message) return setNoteShown(false);
    setNoteShown(true);
    const t = setTimeout(() => setNoteShown(false), 6000);
    return () => clearTimeout(t);
  }, [view.message]);
  if (!me) return null;
  const st = view.status;
  const sync = st === 'live' && view.driftMs !== null ? ` — in sync with the room (±${Math.abs(view.driftMs)} ms)` : '';
  return (
    <div className={`${s.wrap} ${s[st]}`} data-testid="speaker-banner" data-status={st}>
      {st === 'off' && (
        <button className={s.pill} onClick={props.onStart} autoFocus={props.autoFocus} data-testid="start-speaker" title="Hear the room in this tab">
          <LineIcon name="headphones" size={17} />
          <span>Listen</span>
        </button>
      )}
      {st === 'starting' && (
        <button className={s.pill} disabled aria-busy="true">
          <span className={s.spinner} aria-hidden="true" />
          <span>Connecting…</span>
        </button>
      )}
      {st === 'live' && <ListeningMenu slug={props.room.slug} roomName={props.room.name} here={props.here} title={`Listening${sync}`} onStop={props.onStop} />}
      {st === 'paused_elsewhere' && (
        <button className={s.pill} onClick={props.onReclaim} title="Spotify is playing on another device">
          <LineIcon name="headphones" size={17} />
          <span>Play here</span>
        </button>
      )}
      {st === 'error' && (
        <button className={s.pill} onClick={props.onStart} data-testid="start-speaker" title={view.message ?? 'Something went wrong'}>
          <LineIcon name="retry" size={16} />
          <span>Try again</span>
        </button>
      )}
      {/* Why it stopped, briefly, under the button (and read out). */}
      <span className={noteShown && view.message && (st === 'error' || st === 'off') ? s.note : 'sr-only'} role="status">
        {view.message && (st === 'error' || st === 'off') ? view.message : ''}
      </span>
    </div>
  );
}

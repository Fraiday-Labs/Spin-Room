import type { Me } from '@spinroom/contracts';
import type { SpeakerView } from '../speaker/types';
import s from './SpeakerBanner.module.css';

const LABEL: Record<SpeakerView['status'], string> = {
  off: 'Speaker off',
  starting: 'Starting speaker…',
  live: 'Speaker live',
  paused_elsewhere: 'Paused — Spotify is playing elsewhere',
  error: 'Speaker error',
};

/** Inline speaker status: off, starting, live, paused elsewhere, error. */
export function SpeakerBanner(props: {
  me: Me | null;
  view: SpeakerView;
  needsTakeover: boolean;
  onStart: (takeover?: boolean) => void;
  onStop: () => void;
  onReclaim: () => void;
  autoFocus?: boolean;
}) {
  const { me, view } = props;
  if (!me) return null;
  return (
    <div
      className={`${s.banner} ${s[view.status]}`}
      role="status"
      data-testid="speaker-banner"
      data-status={view.status}
      title={view.status === 'live' && view.driftMs !== null ? `In sync with the room (±${Math.abs(view.driftMs)} ms)` : undefined}
    >
      <span className={s.dot} aria-hidden="true" />
      <span className={s.label}>{view.status === 'paused_elsewhere' ? LABEL.paused_elsewhere : (view.message ?? LABEL[view.status])}</span>
      {(view.status === 'off' || view.status === 'error') &&
        (props.needsTakeover ? (
          <button className="btn btn-primary" onClick={() => props.onStart(true)} data-testid="move-speaker">
            Move speaker here
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => props.onStart(false)} autoFocus={props.autoFocus} data-testid="start-speaker">
            Start speaker
          </button>
        ))}
      {view.status === 'paused_elsewhere' && (
        <button className="btn btn-primary" onClick={props.onReclaim}>
          Reclaim
        </button>
      )}
      {view.status === 'live' && (
        <button className="btn btn-ghost" onClick={props.onStop}>
          Stop
        </button>
      )}
    </div>
  );
}

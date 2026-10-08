import type { RoomSnapshot, VoteValue } from '@spinroom/contracts';
import { formatMs } from '@spinroom/sdk';
import { PixelIcon } from '../components/PixelIcon';
import { useNow } from './store';
import s from './PlayerPanel.module.css';

export function SpotifyMark() {
  // Attribution per Spotify's branding guidelines. Swap in the official logo asset from
  // Spotify's brand kit for production (see README → Spotify branding).
  return (
    <span className={s.spotify} aria-label="Spotify">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill="#1ED760" />
        <path
          d="M6 9.2c4-1.2 8.6-.8 12 1.2M6.8 12.4c3.2-.9 6.8-.6 9.6 1M7.6 15.4c2.6-.6 5.2-.4 7.4.8"
          stroke="#000"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      Spotify
    </span>
  );
}

export function PlayerPanel(props: {
  snap: RoomSnapshot;
  djName: string | null;
  onVote: (v: VoteValue | null) => void;
  onSkipSpin: () => void;
  canSkipSpin: boolean;
  volume: number;
  muted: boolean;
  onVolume: (v: number, muted: boolean) => void;
  voteDisabledReason: string | null;
}) {
  const { snap } = props;
  const spin = snap.currentSpin;
  const now = useNow(1000, !!spin);
  const elapsed = spin ? Math.min(spin.durationMs, Math.max(0, now - spin.startedAtServerMs)) : 0;
  const myVote = snap.me?.vote ?? null;
  const trackId = spin?.track.uri.split(':').pop();
  return (
    <section className={s.panel} aria-label="Now playing">
      <div className={s.art}>
        {spin?.track.artUrl ? (
          <img src={spin.track.artUrl} alt={`Album art for ${spin.track.album || spin.track.title}`} width={96} height={96} />
        ) : (
          <div className={s.noArt} />
        )}
      </div>
      <div className={s.meta}>
        {spin ? (
          <>
            <div className={s.title} data-testid="np-title">
              {spin.track.title}
            </div>
            <div className={s.artist}>{spin.track.artists.join(', ')}</div>
            <div className={s.sub}>
              {props.djName && <span>DJ {props.djName}</span>}
              <SpotifyMark />
              <a href={`https://open.spotify.com/track/${trackId}`} target="_blank" rel="noreferrer">
                Open in Spotify
              </a>
            </div>
            <div
              className={s.progress}
              role="progressbar"
              aria-label="Track progress"
              aria-valuemin={0}
              aria-valuemax={spin.durationMs}
              aria-valuenow={elapsed}
              aria-valuetext={`${formatMs(elapsed)} of ${formatMs(spin.durationMs)}`}
            >
              <span style={{ transform: `scaleX(${elapsed / spin.durationMs})` }} />
            </div>
            <div className={s.times}>
              <span>{formatMs(elapsed)}</span>
              <span>{formatMs(spin.durationMs)}</span>
            </div>
          </>
        ) : (
          <div className={s.idleText}>
            {snap.status === 'paused' ? 'Paused — nobody has a speaker on. Start yours to resume.' : 'Booth open — step up and play something.'}
          </div>
        )}
      </div>
      <div className={s.controls}>
        <div className={s.controlRow}>
          <button
            className={`btn btn-hype ${s.vote}`}
            aria-pressed={myVote === 'hype'}
            aria-label={`Hype (thumbs up), ${snap.tally.hype}`}
            disabled={!spin || !!props.voteDisabledReason}
            title={props.voteDisabledReason ?? 'Hype (H)'}
            onClick={() => props.onVote(myVote === 'hype' ? null : 'hype')}
            data-testid="vote-hype"
          >
            <PixelIcon name="thumbUp" size={30} />
            <span className={s.count}>{snap.tally.hype}</span>
          </button>
          <button
            className={`btn btn-skip ${s.vote}`}
            aria-pressed={myVote === 'skip'}
            aria-label={`Skip (thumbs down), ${snap.tally.skip}`}
            disabled={!spin || !!props.voteDisabledReason}
            title={props.voteDisabledReason ?? 'Skip (S)'}
            onClick={() => props.onVote(myVote === 'skip' ? null : 'skip')}
            data-testid="vote-skip"
          >
            <PixelIcon name="thumbDown" size={30} />
            <span className={s.count}>{snap.tally.skip}</span>
          </button>
          <div className={s.volumeGroup}>
            <button
              className={`btn btn-ghost ${s.mute}`}
              aria-pressed={props.muted}
              onClick={() => props.onVolume(props.volume, !props.muted)}
              aria-label={props.muted ? 'Unmute' : 'Mute'}
              title={props.muted ? 'Unmute' : 'Mute'}
            >
              <PixelIcon name={props.muted || props.volume === 0 ? 'speakerMuted' : 'speaker'} size={30} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={props.volume}
              aria-label="Local volume"
              onChange={(e) => props.onVolume(Number(e.target.value), false)}
              className={s.volume}
            />
          </div>
        </div>
        <div className={s.row}>
          <span className="muted" title="Members with a live speaker or who listened recently">
            {snap.tally.eligibleVoters} counted
          </span>
          {props.canSkipSpin && spin && (
            <button className="btn btn-ghost" onClick={props.onSkipSpin} data-testid="skip-spin">
              Skip spin
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

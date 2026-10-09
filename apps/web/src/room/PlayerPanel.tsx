import { spinElapsedMs, type RoomSnapshot, type VoteValue } from '@spinroom/contracts';
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

/** "2 of 5 voted", or who can vote when nobody has yet. */
function voteSummary(snap: RoomSnapshot): string {
  const { hype, skip, eligibleVoters } = snap.tally;
  if (!eligibleVoters) return 'Votes count once listeners start a speaker';
  const voted = hype + skip;
  return voted ? `${voted} of ${eligibleVoters} voted` : `${eligibleVoters} ${eligibleVoters === 1 ? 'listener' : 'listeners'} can vote`;
}

/**
 * Now playing: the track ("Song | Artist", DJ, time) on the left; in the middle, the DJ's Back,
 * Pause/Play and Forward; on the right, the thumbs and your volume. On phones it's a compact
 * strip docked at the bottom of the room.
 */
export function PlayerPanel(props: {
  snap: RoomSnapshot;
  djName: string | null;
  onVote: (v: VoteValue | null) => void;
  onSkipSpin: () => void;
  onPreviousSpin: () => void;
  /** The DJ or a moderator: may go back, pause and skip. */
  canControlSpin: boolean;
  /** You're the DJ of this song (you can't vote on it). */
  isMySpin: boolean;
  onPauseSpin: (paused: boolean) => void;
  volume: number;
  muted: boolean;
  onVolume: (v: number, muted: boolean) => void;
  voteDisabledReason: string | null;
}) {
  const { snap } = props;
  const spin = snap.currentSpin;
  const paused = !!spin?.pausedAtServerMs;
  const now = useNow(1000, !!spin && !paused);
  const elapsed = spin ? Math.min(spin.durationMs, Math.max(0, spinElapsedMs(spin, now))) : 0;
  const myVote = snap.me?.vote ?? null;
  const trackId = spin?.track.uri.split(':').pop();
  const voteOff = !spin || !!props.voteDisabledReason;
  const voteHint = props.voteDisabledReason ?? (spin ? voteSummary(snap) : null);
  return (
    <section className={s.panel} aria-label="Now playing">
      {spin && (
        <div
          className={s.progress}
          role="progressbar"
          aria-label="Track progress"
          aria-valuemin={0}
          aria-valuemax={spin.durationMs}
          aria-valuenow={elapsed}
          aria-valuetext={`${formatMs(elapsed)} of ${formatMs(spin.durationMs)}${paused ? ', paused' : ''}`}
        >
          <span style={{ transform: `scaleX(${elapsed / spin.durationMs})` }} />
        </div>
      )}
      <div className={s.track}>
        <div className={s.art}>
          {spin?.track.artUrl ? <img src={spin.track.artUrl} alt={`Album art for ${spin.track.album || spin.track.title}`} /> : <div className={s.noArt} />}
        </div>
        <div className={s.meta}>
          {spin ? (
            <>
              <div className={s.headline}>
                <span className={s.title} data-testid="np-title">
                  {spin.track.title}
                </span>
                <span className={s.sep} aria-hidden="true">
                  {' '}
                  |{' '}
                </span>
                <span className="sr-only">by </span>
                <span className={s.artist}>{spin.track.artists.join(', ')}</span>
              </div>
              <div className={s.sub}>
                {paused && (
                  <span className={s.pausedTag} data-testid="np-paused">
                    Paused
                  </span>
                )}
                {props.djName && <span>DJ {props.djName}</span>}
                <span className={s.times}>
                  {formatMs(elapsed)} / {formatMs(spin.durationMs)}
                </span>
                <SpotifyMark />
                <a href={`https://open.spotify.com/track/${trackId}`} target="_blank" rel="noreferrer" className={s.open}>
                  Open in Spotify
                </a>
              </div>
            </>
          ) : (
            <div className={s.idleText}>
              {snap.status === 'paused' ? 'Paused — nobody has a speaker on. Start yours to resume.' : 'Booth open — step up and play something.'}
            </div>
          )}
        </div>
      </div>

      <div className={s.transport}>
        {props.canControlSpin && spin && (
          <>
            <button
              className={`${s.iconBtn} ${s.skipBtn}`}
              onClick={props.onPreviousSpin}
              disabled={!snap.previousTrack}
              aria-label={snap.previousTrack ? `Back to the previous song, ${snap.previousTrack.title}` : 'Back to the previous song'}
              title={snap.previousTrack ? `Back to “${snap.previousTrack.title}”` : 'Nothing has played before this song'}
              data-testid="previous-spin"
            >
              <PixelIcon name="previous" size={18} />
            </button>
            <button
              className={`${s.iconBtn} ${s.pause}`}
              onClick={() => props.onPauseSpin(!paused)}
              aria-label={paused ? 'Resume the track for everyone' : 'Pause the track for everyone'}
              title={paused ? 'Resume for everyone' : 'Pause for everyone'}
              data-testid="pause-spin"
            >
              <PixelIcon name={paused ? 'play' : 'pause'} size={18} />
            </button>
            <button
              className={`${s.iconBtn} ${s.skipBtn}`}
              onClick={props.onSkipSpin}
              aria-label="Skip to the next song"
              title="Next song"
              data-testid="skip-spin"
            >
              <PixelIcon name="next" size={18} />
            </button>
          </>
        )}
      </div>

      <div className={s.controls}>
        <div className={`${s.votes} ${props.isMySpin ? s.djVotes : ''}`} role="group" aria-label="Vote" title={voteHint ?? undefined}>
          <button
            className={`${s.iconBtn} ${s.vote} ${s.hype}`}
            aria-pressed={myVote === 'hype'}
            aria-label={`Hype (thumbs up), ${snap.tally.hype}`}
            disabled={voteOff}
            title={props.voteDisabledReason ?? 'Hype (H)'}
            onClick={() => props.onVote(myVote === 'hype' ? null : 'hype')}
            data-testid="vote-hype"
          >
            <PixelIcon name="thumbUp" size={20} />
            <span className={s.count}>{snap.tally.hype}</span>
          </button>
          <button
            className={`${s.iconBtn} ${s.vote} ${s.skip}`}
            aria-pressed={myVote === 'skip'}
            aria-label={`Skip (thumbs down), ${snap.tally.skip}`}
            disabled={voteOff}
            title={props.voteDisabledReason ?? 'Skip (S)'}
            onClick={() => props.onVote(myVote === 'skip' ? null : 'skip')}
            data-testid="vote-skip"
          >
            <PixelIcon name="thumbDown" size={20} />
            <span className={s.count}>{snap.tally.skip}</span>
          </button>
          {voteHint && <span className="sr-only">{voteHint}</span>}
        </div>
        <div className={s.volumeGroup}>
          <button
            className={`${s.iconBtn} ${s.mute}`}
            aria-pressed={props.muted}
            onClick={() => props.onVolume(props.volume, !props.muted)}
            aria-label={props.muted ? 'Unmute' : 'Mute'}
            title={props.muted ? 'Unmute' : 'Mute'}
          >
            <PixelIcon name={props.muted || props.volume === 0 ? 'speakerMuted' : 'speaker'} size={22} />
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
    </section>
  );
}

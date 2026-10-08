import { SLOT_COLORS, type Member, type RoomSnapshot } from '@spinroom/contracts';
import { formatMs } from '@spinroom/sdk';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AvatarSprite } from './AvatarSprite';
import { STAGE_H, STAGE_W, stageScale } from './scale';
import { hash, useNow } from './store';
import s from './Stage.module.css';

const W = STAGE_W;
const H = STAGE_H;
const SLOT_X = [176, 240, 304];
const SPOT_X = [48, 144, 240, 336, 432];
const BEAMS = ['violet', 'cyan', 'magenta', 'amber', 'violet'] as const;
/** Booth slot → spotlight index (slots sit under spotlights 1–3). */
const SLOT_SPOT = [1, 2, 3];
const BOOTH_Y = 148;
/** Crowd figures: avatar width on the 480×270 stage, and the top of the front row. */
const CROWD_W = 32;
const CROWD_Y = 206;
const EQ_COLORS = ['#FF2BD6', '#FF4FA3', '#FFB000', '#FFD24A', '#7CF2B0', '#3DE2FF', '#5B2DFF', '#7A4DFF'];

function useScale(ref: React.RefObject<HTMLDivElement | null>) {
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setK(stageScale(el.clientWidth, el.clientHeight, window.devicePixelRatio || 1));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Moving the window to a screen with a different pixel density doesn't resize it.
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);
  return k;
}

/** Pause scene animation in background tabs (performance budget). */
function useHidden() {
  const [hidden, setHidden] = useState(typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

type Reaction = 'idle' | 'hype' | 'skip';

/**
 * Crowd reactions come from the aggregate tally (individual votes are private, FR-V6):
 * a seeded shuffle per spin picks which figures react. Your own figure shows your vote.
 */
export function crowdReactions(snap: RoomSnapshot, crowd: Member[], myId: string | null): Map<string, Reaction> {
  const out = new Map<string, Reaction>();
  const spinId = snap.currentSpin?.id ?? 'none';
  const myVote = snap.me?.vote ?? null;
  let hype = snap.tally.hype - (myVote === 'hype' ? 1 : 0);
  let skip = snap.tally.skip - (myVote === 'skip' ? 1 : 0);
  const order = crowd.filter((m) => m.user.id !== myId).sort((a, b) => hash(spinId + a.user.id) - hash(spinId + b.user.id));
  for (const m of order) {
    if (hype > 0) {
      out.set(m.user.id, 'hype');
      hype--;
    } else if (skip > 0) {
      out.set(m.user.id, 'skip');
      skip--;
    } else out.set(m.user.id, 'idle');
  }
  if (myId) out.set(myId, myVote ?? 'idle');
  return out;
}

export function Stage({ snap, myId, onSelectMember }: { snap: RoomSnapshot; myId: string | null; onSelectMember?: (m: Member) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const k = useScale(wrap);
  const hidden = useHidden();
  const playing = snap.status === 'playing' && !!snap.currentSpin;
  const members = useMemo(() => new Map(snap.members.map((m) => [m.user.id, m])), [snap.members]);
  const djIds = new Set(snap.booth.map((b) => b.userId).filter(Boolean));
  const activeDj = snap.currentSpin?.djUserId ?? null;
  const activeSlot = snap.booth.find((b) => b.userId === activeDj)?.slot ?? null;
  const hypeHeavy = playing && snap.tally.eligibleVoters > 0 && snap.tally.hype >= snap.room.settings.hypeRatio * snap.tally.eligibleVoters;
  const crowd = snap.members.filter((m) => !djIds.has(m.user.id) && m.presence !== 'away').slice(0, 100);
  const reactions = crowdReactions(snap, crowd, myId);

  return (
    <div ref={wrap} className={`${s.wrap} ${hidden ? 'scene-paused' : ''}`} data-testid="stage">
      <div className={s.box} style={{ width: W * k, height: H * k }}>
        <div className={`${s.scene} ${playing ? s.playing : s.idle}`} style={{ transform: `scale(${k})` }} aria-hidden="true">
          <img className={s.layer} src="/art/back.webp" alt="" width={W} height={H} />
          {SPOT_X.map((x, i) => {
            const isActive = activeSlot !== null && SLOT_SPOT[activeSlot] === i;
            return (
              <img
                key={x}
                className={`${s.beam} ${isActive ? s.beamActive : ''}`}
                src={`/art/beam-${isActive ? (['cyan', 'magenta', 'amber'] as const)[activeSlot!] : BEAMS[i]}.webp`}
                alt=""
                style={{ left: x - 36, animationDelay: `${-i * 1.3}s` }}
              />
            );
          })}
          <img className={s.layer} src="/art/speakers.webp" alt="" />
          <img className={s.led} src="/art/led.webp" alt="" style={{ left: 72, top: 78 }} />
          <img className={s.led} src="/art/led.webp" alt="" style={{ left: 468, top: 78, animationDelay: '-0.4s' }} />
          <div className={s.eq}>
            {Array.from({ length: 24 }, (_, i) => (
              <span
                key={i}
                style={
                  {
                    left: 132 + i * 9,
                    background: EQ_COLORS[i % EQ_COLORS.length],
                    animationDuration: `${0.9 + ((i * 7) % 5) * 0.17}s`,
                    animationDelay: `${-((i * 13) % 10) * 0.11}s`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
          {snap.booth.map((b) => {
            if (!b.userId) return null;
            const m = members.get(b.userId);
            const x = SLOT_X[b.slot] ?? 240;
            const color = SLOT_COLORS[b.slot] ?? SLOT_COLORS[0];
            return (
              <div key={b.slot} className={s.dj} style={{ left: x - 24, top: BOOTH_Y - 46 }} data-testid={`dj-slot-${b.slot}`}>
                <span className={s.label} style={{ color }}>
                  {m?.user.displayName ?? 'DJ'}
                </span>
                {m && <AvatarSprite avatar={m.user.avatar} state={b.userId === activeDj ? 'dj' : 'booth'} width={48} paused={hidden} />}
              </div>
            );
          })}
          <img className={s.layer} src="/art/booth.webp" alt="" />
          {snap.booth.map((b) =>
            b.userId ? (
              <img key={b.slot} className={s.laptop} src="/art/laptop.webp" alt="" style={{ left: (SLOT_X[b.slot] ?? 240) - 12, top: BOOTH_Y - 16 }} />
            ) : null,
          )}
          {hypeHeavy && <div className={s.glow} />}
          <Marquee snap={snap} />
          <img className={s.floor} src="/art/floor.webp" alt="" />
          <div className={s.crowd}>
            {crowd.map((m) => {
              const hsh = hash(m.user.id);
              const row = hsh % 3;
              const x = 6 + (Math.floor(hsh / 3) % 440);
              const y = CROWD_Y + row * 14;
              const r = reactions.get(m.user.id) ?? 'idle';
              return (
                <button
                  key={m.user.id}
                  type="button"
                  tabIndex={-1}
                  className={`${s.fig} ${m.presence === 'remote' ? s.remote : ''} ${m.user.id === myId ? s.me : ''}`}
                  style={{ left: x, top: y, zIndex: y }}
                  onClick={() => onSelectMember?.(m)}
                  title={m.user.displayName}
                  data-testid={`crowd-${m.user.id}`}
                >
                  {/* The same avatar people chose and see at the booth, reacting to the track. */}
                  <AvatarSprite avatar={m.user.avatar} state={r} width={CROWD_W} paused={hidden} />
                  {m.presence === 'remote' && <span className={s.noPhones} />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Marquee({ snap }: { snap: RoomSnapshot }) {
  const spin = snap.currentSpin;
  const now = useNow(1000, !!spin);
  const textRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState<{ from: number; dist: number } | null>(null);
  const text = spin ? `${spin.track.artists.join(', ')} – ${spin.track.title}` : snap.status === 'paused' ? 'PAUSED — START A SPEAKER' : 'BOOTH OPEN — STEP UP';
  useLayoutEffect(() => {
    const tw = textRef.current?.scrollWidth ?? 0;
    const bw = boxRef.current?.clientWidth ?? 0;
    setScroll(tw > bw + 2 ? { from: bw, dist: -tw } : null);
  }, [text]);
  const elapsed = spin ? Math.min(spin.durationMs, Math.max(0, now - spin.startedAtServerMs)) : 0;
  return (
    <div className={s.marquee} data-testid="marquee">
      <div ref={boxRef} className={s.marqueeLine}>
        <span
          ref={textRef}
          className={scroll ? s.scroll : undefined}
          style={
            scroll
              ? ({
                  '--from': `${scroll.from}px`,
                  '--dist': `${scroll.dist}px`,
                  animationDuration: `${Math.max(6, (scroll.from - scroll.dist) / 30)}s`,
                } as CSSProperties)
              : undefined
          }
        >
          {text}
        </span>
      </div>
      {spin && (
        <div className={s.times}>
          <span>{formatMs(elapsed)}</span>
          <span>-{formatMs(spin.durationMs - elapsed)}</span>
        </div>
      )}
    </div>
  );
}

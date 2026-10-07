import type { AvatarRef, AvatarState } from '@spinroom/contracts';
import type { CSSProperties } from 'react';
import s from './AvatarSprite.module.css';

/**
 * Plays one row of a runtime sheet (96×104 cells) with CSS `steps()` — no JS timers.
 * `width` is the displayed width; height follows the 96:104 cell ratio.
 */
export function AvatarSprite({ avatar, state, width, paused, title, className }: { avatar: AvatarRef; state: AvatarState; width: number; paused?: boolean; title?: string; className?: string }) {
  const idx = Math.max(0, avatar.rows.findIndex((r) => r.state === state));
  const row = avatar.rows[idx] ?? avatar.rows[0]!;
  const cols = Math.max(...avatar.rows.map((r) => r.frames));
  const k = width / avatar.cell.w;
  const h = Math.round(avatar.cell.h * k);
  const style = {
    width,
    height: h,
    backgroundImage: `url(${avatar.sheetUrl})`,
    backgroundSize: `${cols * width}px ${avatar.rows.length * h}px`,
    backgroundPositionY: `${-idx * h}px`,
    '--frames': row.frames,
    '--strip': `${-row.frames * width}px`,
    animationDuration: `${Math.max(0.4, row.frames * 0.16)}s`,
    animationPlayState: paused || row.frames < 2 ? 'paused' : undefined,
    opacity: row.dimmed ? 0.55 : undefined,
    imageRendering: avatar.kind === 'preset' ? 'pixelated' : 'auto',
  } as CSSProperties;
  return <div className={`${s.sprite} ${className ?? ''}`} style={style} role={title ? 'img' : undefined} aria-label={title} title={title} />;
}

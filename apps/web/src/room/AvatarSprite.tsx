import type { AvatarRef, AvatarState } from '@spinroom/contracts';
import type { CSSProperties } from 'react';
import s from './AvatarSprite.module.css';

/**
 * Plays one row of a sprite sheet with CSS `steps()` — no JS timers.
 * `width` is the displayed width; height follows the cell ratio.
 */
export function SheetSprite({
  sheetUrl,
  cell,
  row,
  frames,
  cols,
  rowCount,
  width,
  paused,
  dimmed,
  pixelated,
  title,
  className,
}: {
  sheetUrl: string;
  cell: { w: number; h: number };
  row: number;
  frames: number;
  cols: number;
  rowCount: number;
  width: number;
  paused?: boolean;
  dimmed?: boolean;
  pixelated?: boolean;
  title?: string;
  className?: string;
}) {
  const h = Math.round(cell.h * (width / cell.w));
  const style = {
    width,
    height: h,
    backgroundImage: `url(${sheetUrl})`,
    backgroundSize: `${cols * width}px ${rowCount * h}px`,
    backgroundPositionY: `${-row * h}px`,
    '--frames': frames,
    '--strip': `${-frames * width}px`,
    animationDuration: `${Math.max(0.4, frames * 0.16)}s`,
    animationPlayState: paused || frames < 2 ? 'paused' : undefined,
    opacity: dimmed ? 0.55 : undefined,
    imageRendering: pixelated ? 'pixelated' : 'auto',
  } as CSSProperties;
  return <div className={`${s.sprite} ${className ?? ''}`} style={style} role={title ? 'img' : undefined} aria-label={title} title={title} />;
}

/** An avatar in one state. States the sheet lacks (e.g. older sheets without `booth`) play idle. */
export function AvatarSprite({
  avatar,
  state,
  width,
  paused,
  title,
  className,
}: {
  avatar: AvatarRef;
  state: AvatarState;
  width: number;
  paused?: boolean;
  title?: string;
  className?: string;
}) {
  const find = (st: AvatarState) => avatar.rows.findIndex((r) => r.state === st);
  const idx = Math.max(0, find(state) >= 0 ? find(state) : find('idle'));
  const row = avatar.rows[idx] ?? avatar.rows[0]!;
  return (
    <SheetSprite
      sheetUrl={avatar.sheetUrl}
      cell={avatar.cell}
      row={row.at ?? idx}
      frames={row.frames}
      cols={Math.max(...avatar.rows.map((r) => r.frames))}
      rowCount={Math.max(...avatar.rows.map((r, i) => (r.at ?? i) + 1))}
      width={width}
      paused={paused}
      dimmed={row.dimmed}
      pixelated={avatar.kind === 'preset'}
      title={title}
      className={className}
    />
  );
}

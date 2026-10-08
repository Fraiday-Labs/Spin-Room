/** Native art size of the stage scene. */
export const STAGE_W = 480;
export const STAGE_H = 270;

/**
 * Fill the stage area at any window size. Nearest-neighbour (`pixelated`) keeps the art
 * blocky; when a slightly smaller scale lands on whole device pixels, prefer it so every
 * art pixel is the same size.
 */
export function stageScale(width: number, height: number, dpr = 1) {
  const fit = Math.min(width / STAGE_W, (height || Infinity) / STAGE_H);
  if (!Number.isFinite(fit) || fit <= 0) return 1;
  const crisp = Math.floor(fit * dpr) / dpr;
  return Math.max(0.25, crisp >= fit * 0.97 ? crisp : fit);
}


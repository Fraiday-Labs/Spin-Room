import { TIMING } from '@spinroom/contracts';

export type SyncAction =
  | { kind: 'none'; driftMs: number }
  | { kind: 'seek'; positionMs: number; driftMs: number }
  | { kind: 'reload'; positionMs: number; driftMs: number };

/**
 * Drift correction (PRD sync step 4): every 5 s compare the player position with the
 * expected one. Seek when drift > 500 ms; reload the track when drift > 3 s twice in a row.
 */
export class DriftController {
  private bigInARow = 0;
  constructor(
    private readonly seekMs: number = TIMING.driftSeekMs,
    private readonly reloadMs: number = TIMING.driftReloadMs,
  ) {}

  decide(expectedMs: number, actualMs: number): SyncAction {
    const driftMs = actualMs - expectedMs;
    const abs = Math.abs(driftMs);
    if (abs > this.reloadMs) {
      this.bigInARow++;
      if (this.bigInARow >= 2) {
        this.bigInARow = 0;
        return { kind: 'reload', positionMs: Math.max(0, expectedMs), driftMs };
      }
      return { kind: 'seek', positionMs: Math.max(0, expectedMs), driftMs };
    }
    this.bigInARow = 0;
    if (abs > this.seekMs) return { kind: 'seek', positionMs: Math.max(0, expectedMs), driftMs };
    return { kind: 'none', driftMs };
  }

  reset() {
    this.bigInARow = 0;
  }
}

/**
 * Where a speaker should be for a spin right now. Negative means the spin starts in the
 * future (after a fade); callers wait that long, then start at 0.
 */
export function spinPosition(startedAtServerMs: number, serverNowMs: number): number {
  return serverNowMs - startedAtServerMs;
}

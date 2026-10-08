import { TIMING } from '@spinroom/contracts';

export type SyncAction =
  { kind: 'none'; driftMs: number } | { kind: 'seek'; positionMs: number; driftMs: number } | { kind: 'reload'; positionMs: number; driftMs: number };

/**
 * Drift correction (PRD sync step 4): every 5 s compare the player position with the
 * expected one. Each correction is an audible skip, and single readings jitter by a few
 * hundred ms (network clock offset, SDK position granularity), so only act on drift that
 * persists: seek after two readings in a row over `seekMs` (1.5 s), reload the track after
 * two over `reloadMs` (5 s).
 */
export class DriftController {
  private bigInARow = 0;
  private overInARow = 0;
  constructor(
    private readonly seekMs: number = TIMING.driftSeekMs,
    private readonly reloadMs: number = TIMING.driftReloadMs,
  ) {}

  decide(expectedMs: number, actualMs: number): SyncAction {
    const driftMs = actualMs - expectedMs;
    const abs = Math.abs(driftMs);
    const positionMs = Math.max(0, expectedMs);
    if (abs > this.reloadMs) {
      this.overInARow = 0;
      this.bigInARow++;
      if (this.bigInARow >= 2) {
        this.bigInARow = 0;
        return { kind: 'reload', positionMs, driftMs };
      }
      // Way off (a stall or a jump): one seek right away beats several seconds out of sync.
      return { kind: 'seek', positionMs, driftMs };
    }
    this.bigInARow = 0;
    if (abs > this.seekMs) {
      this.overInARow++;
      if (this.overInARow >= 2) {
        this.overInARow = 0;
        return { kind: 'seek', positionMs, driftMs };
      }
      return { kind: 'none', driftMs };
    }
    this.overInARow = 0;
    return { kind: 'none', driftMs };
  }

  reset() {
    this.bigInARow = 0;
    this.overInARow = 0;
  }
}

/**
 * Where a speaker should be for a spin right now. Negative means the spin starts in the
 * future (after a fade); callers wait that long, then start at 0.
 */
export function spinPosition(startedAtServerMs: number, serverNowMs: number): number {
  return serverNowMs - startedAtServerMs;
}

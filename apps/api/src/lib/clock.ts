export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** Test clock that can be advanced manually. */
export class ManualClock implements Clock {
  constructor(private t = 1_700_000_000_000) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
  set(t: number) {
    this.t = t;
  }
}

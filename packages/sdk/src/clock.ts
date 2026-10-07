import { TIMING } from '@spinroom/contracts';

/**
 * NTP-style server clock offset: median of the last N (default 5) samples, where each
 * sample is `serverNow + rtt/2 - localNow` (PRD sync step 2).
 */
export class ServerClock {
  private samples: number[] = [];
  constructor(private readonly keep = TIMING.clockSamples) {}

  addSample(offsetMs: number) {
    this.samples.push(offsetMs);
    if (this.samples.length > this.keep) this.samples.shift();
  }

  /** Record a round trip: t0 = local send, t1 = local receive, server = server time. */
  addRoundTrip(t0: number, server: number, t1: number) {
    this.addSample(server + (t1 - t0) / 2 - t1);
  }

  get offset(): number {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }

  get ready() {
    return this.samples.length > 0;
  }

  /** Current server time estimate. */
  now(local = Date.now()): number {
    return local + this.offset;
  }
}

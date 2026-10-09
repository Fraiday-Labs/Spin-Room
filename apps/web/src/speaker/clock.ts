import { ServerClock } from '@spinroom/sdk';
import { api } from '../lib/api';

/** Shared server clock: seeded by `/v1/time` pings and refreshed by live-socket pongs. */
export const serverClock = new ServerClock();

export async function syncClock(samples = 5) {
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const { serverNow } = await api.call('time.get');
    serverClock.addRoundTrip(t0, serverNow, Date.now());
  }
}

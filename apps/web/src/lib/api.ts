import { ApiError, SpinroomClient } from '@spinroom/sdk';
import type { Me } from '@spinroom/contracts';
import { useQuery, QueryClient } from '@tanstack/react-query';

export function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

let refreshing: Promise<boolean> | null = null;
async function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/v1/auth/session/refresh', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

/** Same-origin client: cookie session + double-submit CSRF, auto-refresh on expiry. */
export const api = new SpinroomClient({
  baseUrl: '',
  surface: 'web',
  csrfToken: () => readCookie('sr_csrf'),
  onSessionExpired: refreshSession,
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

/** The signed-in user, or null when signed out. */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.call('me.get');
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.code === 'session_expired')) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Origin of the live socket. Empty means same origin (dev proxy or a single ingress); set
 * VITE_LIVE_ORIGIN (e.g. wss://api.example.com) when the web app is hosted apart from the API.
 */
export const LIVE_ORIGIN: string = (import.meta.env.VITE_LIVE_ORIGIN ?? '').replace(/\/$/, '');

export function wsUrl(path: string): string {
  if (LIVE_ORIGIN) return `${LIVE_ORIGIN}${path}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

/**
 * The live socket URL for a room. Cross-origin sockets can't carry the session cookie, so
 * signed-in users trade it for a one-time ticket first; signed-out viewers connect bare.
 */
export async function liveRoomUrl(slug: string, signedIn: boolean): Promise<string> {
  const base = wsUrl(`/v1/rooms/${encodeURIComponent(slug)}/live`);
  if (!LIVE_ORIGIN || !signedIn) return base;
  const { ticket } = await api.call('rooms.liveTicket', { params: { slug } });
  return `${base}?ticket=${encodeURIComponent(ticket)}`;
}

export function signInUrl(returnTo = location.pathname + location.search) {
  return `/connect?return_to=${encodeURIComponent(returnTo)}`;
}

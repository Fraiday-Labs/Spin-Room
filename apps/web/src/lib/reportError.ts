declare const __RELEASE__: string;

let sent = 0;

/** Send a caught crash to the server log (`POST /v1/client-errors`). Best effort, a few per page load. */
export function reportError(error: unknown, where: string, componentStack?: string | null) {
  if (sent >= 10) return;
  sent++;
  const e = error instanceof Error ? error : new Error(String(error));
  try {
    void fetch('/v1/client-errors', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: `${e.name}: ${e.message}`.slice(0, 500),
        stack: e.stack?.slice(0, 4000),
        componentStack: componentStack?.slice(0, 4000),
        where,
        url: location.pathname,
        release: typeof __RELEASE__ === 'string' ? __RELEASE__ : 'dev',
      }),
    }).catch(() => {});
  } catch {
    /* never let reporting throw */
  }
}

/** Report errors nothing else caught (event handlers, timers). */
export function installGlobalErrorReporting() {
  window.addEventListener('error', (ev) => {
    // Resource load errors (img/script) have no error object; skip them.
    if (ev.error) reportError(ev.error, 'window');
  });
}

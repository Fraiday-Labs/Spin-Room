import {
  buildPath,
  isProblem,
  routes,
  type Problem,
  type RouteBody,
  type RouteName,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
  type Surface,
} from '@spinroom/contracts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem | null;
  constructor(status: number, problem: Problem | null, fallback: string) {
    super(problem?.detail ?? problem?.title ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem?.code ?? (status === 0 ? 'network_error' : 'internal');
    this.problem = problem;
  }
}

export interface ClientOptions {
  /** API origin, e.g. `https://spinroom.example` (empty string for same-origin browsers). */
  baseUrl: string;
  /** Bearer token provider (MCP, Slack, native). Omit for cookie auth in the browser. */
  getToken?: () => string | null | Promise<string | null>;
  /** Raw Authorization header override (e.g. `Service <secret>`). */
  authorization?: () => string | null;
  /** Which surface is acting; recorded on votes and analytics. */
  surface?: Surface;
  /** Browser cookie auth: read the CSRF cookie for writes. */
  csrfToken?: () => string | null;
  /** Called once on 401 session_expired; return true to retry (after refreshing). */
  onSessionExpired?: () => Promise<boolean>;
  fetch?: typeof fetch;
}

type CallInput<N extends RouteName> = {
  params?: RouteParams<N>;
  query?: RouteQuery<N>;
  body?: RouteBody<N>;
};

/** Typed client generated from the contracts route registry. */
export class SpinroomClient {
  constructor(private readonly o: ClientOptions) {}

  get baseUrl() {
    return this.o.baseUrl;
  }

  url<N extends RouteName>(name: N, input: Pick<CallInput<N>, 'params' | 'query'> = {}): string {
    const def = routes[name];
    const path = buildPath(def.path, (input.params ?? {}) as Record<string, string>);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries((input.query ?? {}) as Record<string, unknown>)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const qs = q.toString();
    return `${this.o.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  async headers(write: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = { accept: 'application/json' };
    const authz = this.o.authorization?.();
    if (authz) h.authorization = authz;
    else {
      const token = await this.o.getToken?.();
      if (token) h.authorization = `Bearer ${token}`;
    }
    if (this.o.surface) h['x-spinroom-surface'] = this.o.surface;
    if (write) {
      const csrf = this.o.csrfToken?.();
      if (csrf) h['x-csrf-token'] = csrf;
    }
    return h;
  }

  async call<N extends RouteName>(name: N, input: CallInput<N> = {}, opts: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<RouteResponse<N>> {
    return this.send(name, input, opts, true);
  }

  private async send<N extends RouteName>(name: N, input: CallInput<N>, opts: { idempotencyKey?: string; signal?: AbortSignal }, mayRetry: boolean): Promise<RouteResponse<N>> {
    const def = routes[name];
    const write = def.method !== 'GET';
    const headers = await this.headers(write);
    let body: string | undefined;
    if (write && input.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(input.body);
    }
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    const f = this.o.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(this.url(name, input), {
        method: def.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        credentials: 'include',
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      throw new ApiError(0, null, `Network error: ${(e as Error).message}`);
    }
    const text = await res.text();
    const json: unknown = text ? safeJson(text) : null;
    if (!res.ok) {
      const problem = isProblem(json) ? json : null;
      if (res.status === 401 && mayRetry && this.o.onSessionExpired && (await this.o.onSessionExpired())) {
        return this.send(name, input, opts, false);
      }
      throw new ApiError(res.status, problem, `${def.method} ${def.path} failed (${res.status})`);
    }
    return json as RouteResponse<N>;
  }

  /** Multipart upload (avatars). */
  async upload<N extends RouteName>(name: N, form: FormData, input: Pick<CallInput<N>, 'params' | 'query'> = {}): Promise<RouteResponse<N>> {
    const headers = await this.headers(true);
    const f = this.o.fetch ?? fetch;
    const res = await f(this.url(name, input), { method: routes[name].method, headers, body: form, credentials: 'include' });
    const json = safeJson(await res.text());
    if (!res.ok) throw new ApiError(res.status, isProblem(json) ? json : null, `upload failed (${res.status})`);
    return json as RouteResponse<N>;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

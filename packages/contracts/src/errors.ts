import { z } from 'zod';

/**
 * Stable error codes returned in RFC 9457 problem documents.
 * Clients branch on `code`, never on `title` or `detail`.
 */
export const ERROR_CODES = {
  bad_request: 400,
  validation_failed: 400,
  invalid_client_id: 400,
  unauthenticated: 401,
  session_expired: 401,
  csrf_failed: 403,
  forbidden: 403,
  not_premium: 403,
  banned: 403,
  muted: 403,
  not_member: 403,
  origin_rejected: 403,
  upload_revoked: 403,
  not_found: 404,
  room_not_found: 404,
  spin_not_current: 409,
  conflict: 409,
  slug_taken: 409,
  already_in_queue: 409,
  speaker_exists: 409,
  invalid_invite: 410,
  room_closed: 410,
  room_full: 409,
  crate_empty: 422,
  on_cooldown: 422,
  speaker_missing: 422,
  track_too_long: 422,
  track_unplayable: 422,
  track_explicit: 422,
  cannot_vote_own_spin: 422,
  not_present: 422,
  avatar_invalid: 422,
  avatar_limit: 422,
  rights_not_confirmed: 422,
  payload_too_large: 413,
  unsupported_image: 415,
  rate_limited: 429,
  quota_exceeded: 429,
  spotify_error: 502,
  spotify_auth_failed: 502,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export const ErrorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCodeSchema,
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Extra machine-readable context, e.g. `cooldownUntil`, `speakerUrl`, `issues`. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export class SpinroomError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, detail?: string, meta?: Record<string, unknown>) {
    super(detail ?? code);
    this.name = 'SpinroomError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.meta = meta;
  }

  toProblem(instance?: string): Problem {
    return {
      type: `https://spinroom.dev/problems/${this.code}`,
      title: this.code.replace(/_/g, ' '),
      status: this.status,
      code: this.code,
      detail: this.message,
      ...(instance ? { instance } : {}),
      ...(this.meta ? { meta: this.meta } : {}),
    };
  }
}

export function isProblem(value: unknown): value is Problem {
  return ProblemSchema.safeParse(value).success;
}

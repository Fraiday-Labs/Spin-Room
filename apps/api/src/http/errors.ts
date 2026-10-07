import { SpinroomError } from '@spinroom/contracts';
import type { FastifyError, FastifyInstance } from 'fastify';
import { SpotifyApiError } from '../spotify/gateway.js';

/** Map any thrown error to an RFC 9457 problem document with a stable `code`. */
export function toSpinroomError(e: unknown): SpinroomError {
  if (e instanceof SpinroomError) return e;
  if (e instanceof SpotifyApiError) {
    if (e.isQuota) return new SpinroomError('quota_exceeded', 'Your Spotify developer quota is used up for now — try again later');
    if (e.status === 401) return new SpinroomError('spotify_auth_failed', 'Spotify session expired — reconnect Spotify');
    if (e.status === 403) return new SpinroomError('spotify_error', `Spotify refused the request: ${e.message}`, { spotifyStatus: 403 });
    return new SpinroomError('spotify_error', e.message, { spotifyStatus: e.status });
  }
  const fe = e as FastifyError;
  if (fe?.code === 'FST_REQ_FILE_TOO_LARGE' || fe?.statusCode === 413) return new SpinroomError('payload_too_large', 'Upload is too large');
  if (fe?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fe?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || fe?.code?.startsWith?.('FST_ERR_CTP')) {
    return new SpinroomError('bad_request', fe.message);
  }
  if (fe?.validation || fe?.statusCode === 400) return new SpinroomError('bad_request', fe.message);
  return new SpinroomError('internal', 'Something went wrong');
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    const se = toSpinroomError(err);
    if (se.code === 'internal') req.log.error({ err }, 'unhandled error');
    else if (se.code === 'spotify_error' || se.code === 'quota_exceeded') req.log.warn({ err }, 'spotify error');
    reply.code(se.status).type('application/problem+json').send(se.toProblem(req.url));
  });
  app.setNotFoundHandler((req, reply) => {
    const se = new SpinroomError('not_found', `No route for ${req.method} ${req.url.split('?')[0]}`);
    reply.code(404).type('application/problem+json').send(se.toProblem(req.url));
  });
}

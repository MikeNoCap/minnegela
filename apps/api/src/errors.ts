import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import type { ApiErrorCode } from '@minnegela/shared';

/**
 * RFC 7807 problem with a machine-readable `code` the apps translate; `detail` is English for logs and
 * as a fallback. Out-of-scope entities always surface as 404 so existence is not disclosed.
 */
export class HttpError extends Error {
  constructor(public status: number, public title: string, public code: ApiErrorCode, public detail?: string, public extra?: Record<string, unknown>) {
    super(detail ?? title);
  }
}
export const notFound = (code: ApiErrorCode = 'not_found', detail = 'Not found') => new HttpError(404, 'Not Found', code, detail);
export const badRequest = (code: ApiErrorCode, detail: string, extra?: Record<string, unknown>) => new HttpError(400, 'Bad Request', code, detail, extra);
export const unauthorized = (code: ApiErrorCode = 'sign_in_required', detail = 'Sign in required') => new HttpError(401, 'Unauthorized', code, detail);
export const forbidden = (code: ApiErrorCode = 'not_allowed', detail = 'Not allowed') => new HttpError(403, 'Forbidden', code, detail);
export const conflict = (code: ApiErrorCode, detail: string) => new HttpError(409, 'Conflict', code, detail);

export function errorHandler(err: FastifyError | HttpError | Error, req: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, title: string, code: ApiErrorCode, detail?: string, extra?: Record<string, unknown>) =>
    reply.status(status).type('application/problem+json').send({ type: 'about:blank', title, status, code, detail, instance: req.url, ...extra });
  if (err instanceof HttpError) return send(err.status, err.title, err.code, err.detail, err.extra);
  if (hasZodFastifySchemaValidationErrors(err)) {
    return send(400, 'Bad Request', 'validation_failed', 'Request validation failed', { issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) });
  }
  if (isResponseSerializationError(err)) {
    req.log.error({ err }, 'response serialization failed');
    return send(500, 'Internal Server Error', 'internal_error', 'Response did not match schema');
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) req.log.error({ err }, 'unhandled error');
  const [title, code]: [string, ApiErrorCode] = status === 404 ? ['Not Found', 'not_found'] : status === 429 ? ['Too Many Requests', 'rate_limited'] : status >= 500 ? ['Internal Server Error', 'internal_error'] : ['Error', 'error'];
  return send(status, title, code, status >= 500 ? undefined : err.message);
}

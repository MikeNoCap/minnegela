import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

/** RFC 7807 problem. Out-of-scope entities always surface as 404 so existence is not disclosed. */
export class HttpError extends Error {
  constructor(public status: number, public title: string, public detail?: string, public extra?: Record<string, unknown>) {
    super(detail ?? title);
  }
}
export const notFound = (detail = 'Not found') => new HttpError(404, 'Not Found', detail);
export const badRequest = (detail: string, extra?: Record<string, unknown>) => new HttpError(400, 'Bad Request', detail, extra);
export const unauthorized = (detail = 'Sign in required') => new HttpError(401, 'Unauthorized', detail);
export const forbidden = (detail = 'Not allowed') => new HttpError(403, 'Forbidden', detail);
export const conflict = (detail: string) => new HttpError(409, 'Conflict', detail);

export function errorHandler(err: FastifyError | HttpError | Error, req: FastifyRequest, reply: FastifyReply) {
  const send = (status: number, title: string, detail?: string, extra?: Record<string, unknown>) =>
    reply.status(status).type('application/problem+json').send({ type: 'about:blank', title, status, detail, instance: req.url, ...extra });
  if (err instanceof HttpError) return send(err.status, err.title, err.detail, err.extra);
  if (hasZodFastifySchemaValidationErrors(err)) {
    return send(400, 'Bad Request', 'Request validation failed', { issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) });
  }
  if (isResponseSerializationError(err)) {
    req.log.error({ err }, 'response serialization failed');
    return send(500, 'Internal Server Error', 'Response did not match schema');
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) req.log.error({ err }, 'unhandled error');
  return send(status, status === 404 ? 'Not Found' : status === 429 ? 'Too Many Requests' : status >= 500 ? 'Internal Server Error' : 'Error', status >= 500 ? undefined : err.message);
}

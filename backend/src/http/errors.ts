/**
 * Unified error contract (D-S3-06): every error response is
 *   { "error": { "code": "SOME_CODE", "message": "safe text", ...safeDetails } }
 * Messages never include passwords, tokens, hashes, SQL or stack traces.
 */
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function sendError(reply: FastifyReply, error: ApiError): FastifyReply {
  if (error.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
  return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...error.details } });
}

export const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof ApiError) return sendError(reply, error);
    if (error.validation) {
      return sendError(reply, new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed'));
    }
    switch (error.code) {
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return sendError(reply, new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return sendError(reply, new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
        return sendError(reply, new ApiError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON'));
    }
    if (error.statusCode === 400) {
      return sendError(reply, new ApiError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON'));
    }
    return sendError(reply, new ApiError(500, 'INTERNAL_ERROR', 'Internal server error'));
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, new ApiError(404, 'NOT_FOUND', 'Route not found')));
}

/**
 * One error shape for the whole API:
 *   { "error": "<machine_code>", "message": "<human explanation>" }
 *
 * Routes throw ApiError; the error middleware in server.ts renders it. Anything
 * else that escapes a route becomes a 500 with the same shape, so a client
 * never has to parse two different error formats.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code: string, message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(400, code, message, details);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static upstream(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(502, 'upstream_unavailable', message, details);
  }
}

export interface ErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export function toErrorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body:
        err.details === undefined
          ? { error: err.code, message: err.message }
          : { error: err.code, message: err.message, details: err.details },
    };
  }
  return {
    status: 500,
    body: {
      error: 'internal_error',
      message: err instanceof Error ? err.message : 'Unexpected error',
    },
  };
}

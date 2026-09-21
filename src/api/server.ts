import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { logger } from '../logger.js';
import { supplierRouter } from '../suppliers/routes.js';
import { apiRouter } from './routes/index.js';
import { ApiError, toErrorBody } from './errors.js';
import { mapInfrastructureError } from './error-mapping.js';

export function createServer(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());
  app.use(requestLogger);

  // The orchestrator's own API.
  app.use(apiRouter);

  // Mock supplier APIs, co-hosted for convenience (see suppliers/routes.ts).
  app.use(supplierRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Tags every request with an id, echoes it back in the `x-request-id` header,
 * and logs one line per completed request. The id is what ties an API log line
 * to the activity log lines it caused.
 */
function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.header('x-request-id');
  const requestId = headerValue !== undefined && headerValue !== '' ? headerValue : randomUUID();

  res.locals['requestId'] = requestId;
  res.setHeader('x-request-id', requestId);

  logger.debug({ requestId, method: req.method, path: req.path, query: req.query }, 'request started');

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const line = {
      requestId,
      method: req.method,
      path: req.path,
      query: req.query,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
    };
    if (res.statusCode >= 500) logger.error(line, 'request failed');
    else if (res.statusCode >= 400) logger.warn(line, 'request rejected');
    else logger.info(line, 'request completed');
  });

  next();
}

function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`No route for ${req.method} ${req.path}`));
}

/**
 * The single place that turns a thrown value into an HTTP response, so every
 * error the API emits has the same JSON shape.
 */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // Translate infrastructure failures (Temporal down, Redis down, workflow
  // failed) into meaningful statuses before rendering.
  const mapped = mapInfrastructureError(err);
  const { status, body } = toErrorBody(mapped);
  const requestId = res.locals['requestId'] as string | undefined;

  if (status >= 500) logger.error({ err, requestId, status, code: body.error }, 'request failed with server error');
  else logger.warn({ requestId, status, code: body.error }, 'request rejected');

  if (res.headersSent) return;
  res.status(status).json(body);
}

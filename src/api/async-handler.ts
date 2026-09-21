import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Adapt an async route handler to Express 4, which ignores returned promises.
 *
 * Without this, a rejection that escapes a handler becomes an unhandled promise
 * rejection and the client is left hanging until timeout — instead of being
 * routed to the central error middleware. Wrapping here means handlers can
 * simply `await` and let anything thrown bubble.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

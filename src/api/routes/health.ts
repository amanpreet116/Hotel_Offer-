import { Router, type Request, type Response } from 'express';
import { checkHealth, httpStatusFor } from '../health.js';
import { asyncHandler } from '../async-handler.js';

export const healthRouter: Router = Router();

/**
 * GET /health — live probes of both suppliers, Redis and Temporal.
 *
 * 200 when healthy or degraded (one supplier down, still serving),
 * 503 when a critical dependency is down.
 */
healthRouter.get(
  '/health',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const report = await checkHealth();
    res.status(httpStatusFor(report.status)).json(report);
  }),
);

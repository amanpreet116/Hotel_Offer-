import { Router } from 'express';
import { docsRouter } from './docs.js';
import { healthRouter } from './health.js';
import { hotelsRouter } from './hotels.js';

/** Aggregates the orchestrator's own routes. */
export const apiRouter: Router = Router();

apiRouter.use(docsRouter);
apiRouter.use(healthRouter);
apiRouter.use(hotelsRouter);

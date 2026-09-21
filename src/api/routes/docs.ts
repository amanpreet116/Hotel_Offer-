import { Router, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from '../openapi.js';

/**
 * Interactive API documentation.
 *
 *   GET /api-docs       Swagger UI
 *   GET /api-docs.json  the raw OpenAPI 3.0 document
 *
 * Mounted on the same Express app, so it is available wherever the API is —
 * including under `docker compose up` — with no extra service.
 */
export const docsRouter: Router = Router();

// Must be registered before the UI mount: swagger-ui-express serves its own
// index at the mount path, which would otherwise swallow this.
docsRouter.get('/api-docs.json', (_req: Request, res: Response) => {
  res.json(openApiDocument);
});

docsRouter.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, {
    customSiteTitle: 'Hotel Offer Orchestrator — API docs',
    swaggerOptions: {
      // Keep the page usable: collapsed operations, and models expanded enough
      // to read the shapes without clicking.
      docExpansion: 'list',
      defaultModelsExpandDepth: 2,
      displayRequestDuration: true,
      tryItOutEnabled: true,
    },
  }),
);

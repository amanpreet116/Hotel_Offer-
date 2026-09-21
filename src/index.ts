import type { Server } from 'node:http';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { createServer } from './api/server.js';
import { closeTemporalClient, warmTemporalClient } from './temporal/client.js';
import { closeRedis } from './redis/client.js';
import { registerShutdown } from './shutdown.js';

const app = createServer();

const server: Server = app.listen(config.api.port, () => {
  logger.info(
    { port: config.api.port, env: config.env, temporal: config.temporal.address, redis: config.redis.url },
    `Hotel Offer Orchestrator API listening on http://localhost:${config.api.port}`,
  );
});

// Establish the Temporal connection up front rather than on the first request.
warmTemporalClient();

registerShutdown('api', [
  // Stop accepting connections first, then tear down what the in-flight
  // requests were still using.
  { name: 'http-server', run: () => new Promise<void>((resolve) => server.close(() => resolve())) },
  { name: 'temporal-client', run: closeTemporalClient },
  { name: 'redis', run: closeRedis },
]);

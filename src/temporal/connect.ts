import { config } from '../config/index.js';
import { logger } from '../logger.js';

/**
 * Retry a Temporal connection with exponential backoff.
 *
 * Under `docker compose up` the API and worker can win the race against
 * Temporal even with `depends_on: service_healthy` — the frontend accepts gRPC
 * connections slightly before the default namespace finishes registering. This
 * turns that window into a few quiet retries instead of a crash loop.
 */
export async function connectWithRetry<T>(label: string, connect: () => Promise<T>): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs } = config.temporal.connect;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const connection = await connect();
      if (attempt > 1) logger.info({ label, attempt }, 'temporal connection established after retries');
      return connection;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;

      const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      logger.warn(
        { label, attempt, maxAttempts, delayMs, err: err instanceof Error ? err.message : String(err) },
        'temporal not reachable yet, retrying',
      );
      await sleep(delayMs);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Could not connect to Temporal at ${config.temporal.address} after ${maxAttempts} attempts: ${message}`,
    {
      cause: lastError,
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

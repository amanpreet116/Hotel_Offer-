import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../logger.js';

/**
 * One lazily-created Redis connection per process, shared by the API and by
 * the worker's activities. ioredis reconnects on its own, so the same instance
 * survives a Redis restart.
 */

let client: Redis | undefined;

export function getRedis(): Redis {
  if (client === undefined) {
    client = new Redis(config.redis.url, {
      lazyConnect: false,
      // Bounded retries plus a command timeout give the fail-fast behaviour a
      // Temporal activity needs, without the failure mode of a disabled
      // offline queue: with that off, a command issued in the moments between
      // process start and the socket becoming ready is rejected outright,
      // which shows up as a spurious 503 right after boot.
      maxRetriesPerRequest: 2,
      commandTimeout: config.redis.commandTimeoutMs,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });

    client.on('error', (err: Error) => logger.error({ err: err.message }, 'redis error'));
    client.on('connect', () => logger.info({ url: config.redis.url }, 'redis connected'));
    client.on('reconnecting', () => logger.warn('redis reconnecting'));
  }
  return client;
}

/** True if Redis answers a PING. Used by the health endpoint. */
export async function pingRedis(): Promise<boolean> {
  try {
    return (await getRedis().ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client === undefined) return;
  const closing = client;
  client = undefined;
  await closing.quit().catch(() => closing.disconnect());
  logger.info('redis connection closed');
}

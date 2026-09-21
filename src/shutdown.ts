import { config } from './config/index.js';
import { logger } from './logger.js';

/**
 * Shared graceful-shutdown plumbing for both entrypoints.
 *
 * Containers get SIGTERM from `docker stop` and a terminal gives SIGINT. Either
 * way we want the same thing: stop taking new work, let in-flight work finish,
 * close connections, exit 0 — and never hang forever doing it.
 */

interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

/**
 * Steps run strictly in order, because shutdown order matters: stop accepting
 * work before closing the connections that in-flight work is still using.
 */
export function registerShutdown(name: string, steps: ShutdownStep[]): void {
  let shuttingDown = false;

  const run = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ name, signal }, 'second signal received, exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ name, signal, graceMs: config.shutdown.graceMs }, 'shutting down gracefully');

    // A dependency that refuses to close must not keep the container alive.
    const forceExit = setTimeout(() => {
      logger.error({ name, graceMs: config.shutdown.graceMs }, 'shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdown.graceMs);
    forceExit.unref();

    for (const step of steps) {
      try {
        await step.run();
        logger.debug({ name, step: step.name }, 'shutdown step complete');
      } catch (err) {
        // One stuck dependency must not prevent the rest from closing.
        logger.warn({ name, step: step.name, err: messageOf(err) }, 'shutdown step failed');
      }
    }

    clearTimeout(forceExit);
    logger.info({ name }, 'shutdown complete');
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void run(signal));
  }

  // Never die silently: log the reason first, then let the process go.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ name, err: messageOf(reason) }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err: Error) => {
    logger.fatal({ name, err: err.message, stack: err.stack }, 'uncaught exception, exiting');
    process.exit(1);
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

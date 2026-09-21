import { fileURLToPath } from 'node:url';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import * as activities from './activities.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { closeRedis } from '../redis/client.js';
import { registerShutdown } from '../shutdown.js';
import { connectWithRetry } from './connect.js';
import { TASK_QUEUE_NAME } from './shared.js';

/**
 * The Temporal worker: a process of its own, separate from the Express API.
 * It polls the task queue and runs workflow and activity code. Scale or restart
 * it independently of the API — that separation is the point.
 */
async function main(): Promise<void> {
  // Take the SDK's own SIGINT/SIGTERM handling out of the picture: shutdown is
  // driven by registerShutdown below, so that draining and connection teardown
  // happen in a defined order instead of two handlers racing.
  Runtime.install({ shutdownSignals: [] });

  const connection = await connectWithRetry('worker', () =>
    NativeConnection.connect({ address: config.temporal.address }),
  );

  const worker = await Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: TASK_QUEUE_NAME,
    workflowsPath: resolveWorkflowsPath(),
    activities,
    bundlerOptions: {
      // Our sources use NodeNext, so relative imports carry a `.js` extension
      // even in `.ts` files. Teach the workflow bundler to follow those back
      // to the TypeScript source.
      webpackConfigHook: (cfg) => {
        cfg.resolve ??= {};
        cfg.resolve.extensionAlias = { ...cfg.resolve.extensionAlias, '.js': ['.ts', '.js'] };
        return cfg;
      },
    },
  });

  logger.info(
    { address: config.temporal.address, namespace: config.temporal.namespace, taskQueue: TASK_QUEUE_NAME },
    'Temporal worker ready',
  );

  const running = worker.run();

  registerShutdown('worker', [
    // shutdown() only *initiates* draining; run() is what resolves once every
    // in-flight activity has finished. Closing the connection before that
    // point fails with "Workers hold a reference to it".
    {
      name: 'worker-drain',
      run: async () => {
        worker.shutdown();
        await running;
      },
    },
    { name: 'temporal-connection', run: () => connection.close() },
    { name: 'redis', run: closeRedis },
  ]);

  await running;
  logger.info('Temporal worker drained');
}

/**
 * Point the bundler at `workflows.ts` under tsx and `workflows.js` under
 * `dist/`, deciding from how this very module was loaded.
 */
function resolveWorkflowsPath(): string {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return fileURLToPath(new URL(`./workflows${extension}`, import.meta.url));
}

main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Temporal worker failed to start');
  process.exit(1);
});

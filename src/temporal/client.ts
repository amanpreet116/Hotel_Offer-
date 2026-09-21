import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import type { HotelOffer } from '../domain/types.js';
import { connectWithRetry } from './connect.js';
import { TASK_QUEUE_NAME, hotelsWorkflowId } from './shared.js';
import type { getHotelsWorkflow } from './workflows.js';

/**
 * Thin client wrapper used by the Express API (and the verify script) to run
 * workflows. The connection is expensive, so it is created once and reused for
 * the life of the process.
 */

/**
 * Message used for "Temporal did not answer in time". The HTTP layer matches on
 * it to turn the failure into a 503 rather than an opaque 500.
 */
export const TEMPORAL_UNREACHABLE = 'Could not connect to Temporal: the server did not accept the request in time';

let clientPromise: Promise<Client> | undefined;

export async function getTemporalClient(): Promise<Client> {
  if (clientPromise === undefined) {
    // Clear the memo on failure so the next request retries instead of
    // permanently caching a rejected promise.
    clientPromise = createClient().catch((err: unknown) => {
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

async function createClient(): Promise<Client> {
  logger.info({ address: config.temporal.address, namespace: config.temporal.namespace }, 'connecting to Temporal');
  const connection = await connectWithRetry('client', () =>
    // Bound each individual attempt, or a dead server makes one attempt hang
    // instead of failing so the backoff can take over.
    Connection.connect({ address: config.temporal.address, connectTimeout: config.temporal.connect.maxDelayMs }),
  );
  logger.info({ address: config.temporal.address }, 'Temporal client connected');
  return new Client({ connection, namespace: config.temporal.namespace });
}

export interface RunOptions {
  /** Correlation id from the HTTP layer, carried into the workflow's memo. */
  requestId?: string;
}

/**
 * Run the aggregation workflow for a city and wait for its result.
 *
 * The workflow id is derived from the city, and the conflict policy is
 * USE_EXISTING, so simultaneous requests for the same city attach to one
 * running execution instead of hitting the suppliers twice over. Once that run
 * completes, the reuse policy lets the next request start a fresh one.
 */
export async function runGetHotelsWorkflow(city: string, options: RunOptions = {}): Promise<HotelOffer[]> {
  // Bound client acquisition as well as the start call. getTemporalClient()
  // retries with backoff for up to a couple of minutes, which is right at
  // startup but far too long to keep an HTTP request waiting: fail fast here
  // and let the reconnect continue in the background.
  const client = await withTimeout(getTemporalClient(), config.temporal.startTimeoutMs, TEMPORAL_UNREACHABLE);
  const workflowId = hotelsWorkflowId(city);
  const { requestId } = options;
  const startedAt = Date.now();

  const handle = await withTimeout(
    client.workflow.start<typeof getHotelsWorkflow>('getHotelsWorkflow', {
      taskQueue: TASK_QUEUE_NAME,
      workflowId,
      args: [city],
      workflowExecutionTimeout: config.temporal.workflowExecutionTimeout,
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      workflowIdConflictPolicy: 'USE_EXISTING',
      // Memo is queryable in the Temporal UI, which is how you get from an API
      // log line to the exact workflow run it triggered.
      ...(requestId === undefined ? {} : { memo: { requestId } }),
    }),
    config.temporal.startTimeoutMs,
    TEMPORAL_UNREACHABLE,
  );

  logger.info({ city, workflowId, runId: handle.firstExecutionRunId, requestId }, 'workflow started');

  try {
    const offers = await handle.result();
    logger.info(
      {
        city,
        workflowId,
        runId: handle.firstExecutionRunId,
        requestId,
        count: offers.length,
        durationMs: Date.now() - startedAt,
      },
      'workflow completed',
    );
    return offers;
  } catch (err) {
    logger.error(
      {
        city,
        workflowId,
        runId: handle.firstExecutionRunId,
        requestId,
        durationMs: Date.now() - startedAt,
        err: describeWorkflowFailure(err),
      },
      'workflow failed',
    );
    throw err;
  }
}

/**
 * A single, non-retrying liveness probe for /health.
 *
 * Deliberately does not go through connectWithRetry: a health check must
 * answer within its timeout and report "down", not spend 30 backoff attempts
 * trying to make the answer "up".
 */
export async function pingTemporal(timeoutMs: number): Promise<void> {
  const probe = async (): Promise<void> => {
    if (clientPromise !== undefined) {
      const client = await clientPromise;
      await client.connection.workflowService.getSystemInfo({});
      return;
    }

    // Not connected yet (or the last attempt failed): try once, briefly.
    const connection = await Connection.connect({
      address: config.temporal.address,
      connectTimeout: timeoutMs,
    });
    try {
      await connection.workflowService.getSystemInfo({});
    } finally {
      await connection.close().catch(() => undefined);
    }
  };

  await withTimeout(probe(), timeoutMs, `Temporal did not respond within ${timeoutMs}ms`);
}

/** Unwrap a Temporal workflow failure into something worth putting in a log. */
export function describeWorkflowFailure(err: unknown): string {
  if (err instanceof WorkflowFailedError) {
    const cause = err.cause;
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Start connecting in the background at boot, so the first real request does
 * not pay for the handshake. Failures are logged, never thrown: the API should
 * still start (and serve /health) when Temporal is not up yet.
 */
export function warmTemporalClient(): void {
  void getTemporalClient().catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'could not pre-connect to Temporal; will retry on first request',
    );
  });
}

/** Close the shared connection during shutdown. */
export async function closeTemporalClient(): Promise<void> {
  if (clientPromise === undefined) return;
  const pending = clientPromise;
  clientPromise = undefined;
  try {
    const client = await pending;
    await client.connection.close();
    logger.info('Temporal connection closed');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Temporal connection was not open');
  }
}

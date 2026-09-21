import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { ApiError } from './errors.js';

/**
 * Turn infrastructure failures into HTTP responses that say something useful.
 *
 * Without this, a Redis outage and a genuine bug both surface as an opaque
 * 500. Called from the central error middleware, so every route benefits.
 */
export function mapInfrastructureError(err: unknown): unknown {
  if (err instanceof ApiError) return err;

  if (err instanceof WorkflowFailedError) return mapWorkflowFailure(err);
  if (isTemporalConnectionError(err)) {
    return new ApiError(
      503,
      'temporal_unavailable',
      'Temporal is not reachable; the request could not be orchestrated',
      {
        cause: messageOf(err),
      },
    );
  }
  if (isRedisError(err)) {
    return new ApiError(
      503,
      'redis_unavailable',
      'Redis is not reachable; cached offers could not be read or written',
      {
        cause: messageOf(err),
      },
    );
  }

  return err;
}

function mapWorkflowFailure(err: WorkflowFailedError): ApiError {
  // Temporal nests failures several layers deep — WorkflowFailedError wraps an
  // ActivityFailure ("Activity task failed") which wraps the ApplicationFailure
  // that actually says what went wrong. Only the whole chain is diagnostic.
  const chain = causeChain(err);
  const joined = chain.map(messageOf).join(' | ');
  const deepest = chain.length > 0 ? messageOf(chain[chain.length - 1]) : err.message;

  if (chain.some((link) => link instanceof ApplicationFailure && link.type === 'AllSuppliersUnavailable')) {
    return new ApiError(502, 'suppliers_unavailable', 'Both suppliers are unavailable; no offers could be aggregated', {
      cause: deepest,
    });
  }

  // A workflow can also fail because saveToRedis exhausted its retries.
  if (/redis|could not cache offers/i.test(joined)) {
    return new ApiError(503, 'redis_unavailable', 'Offers were aggregated but could not be cached', {
      cause: deepest,
    });
  }

  return new ApiError(502, 'workflow_failed', 'The aggregation workflow did not complete', { cause: deepest });
}

/** Flatten an error's `cause` chain into a list, innermost last. */
function causeChain(err: unknown, depth = 0): unknown[] {
  if (err === undefined || err === null || depth > 10) return [];
  const cause = err instanceof Error ? err.cause : undefined;
  return cause === undefined ? [err] : [err, ...causeChain(cause, depth + 1)];
}

/**
 * Heuristic: the SDK surfaces transport problems as plain errors, so there is
 * no single class to test for. Our own connectWithRetry message is the
 * reliable signal; the rest are the gRPC shapes seen in practice.
 */
function isTemporalConnectionError(err: unknown): boolean {
  const message = messageOf(err);
  return (
    message.includes('Could not connect to Temporal') ||
    message.includes('Failed to connect before the deadline') ||
    message.includes('Connection dropped') ||
    (message.includes('UNAVAILABLE') && message.toLowerCase().includes('temporal'))
  );
}

function isRedisError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'ReplyError' || err.name === 'MaxRetriesPerRequestError') return true;

  const message = err.message;
  return (
    message.includes("Stream isn't writeable") ||
    message.includes('Connection is closed') ||
    message.includes('Command timed out') ||
    message.includes('Reached the max retries per request limit') ||
    (message.includes('ECONNREFUSED') && message.includes('6379'))
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

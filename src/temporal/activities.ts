import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { SUPPLIER_A, SUPPLIER_B, isRawHotel, toHotelOffer } from '../domain/types.js';
import type { HotelOffer, RawHotel, SupplierId } from '../domain/types.js';
import { saveOffers } from '../redis/repository.js';

/**
 * Temporal activities: the only place in the orchestration path where I/O is
 * allowed. Workflow code must stay deterministic, so every HTTP call and every
 * Redis access lives here.
 *
 * All three activities are idempotent — two are reads, and saveToRedis
 * overwrites one city's snapshot wholesale — which is what makes Temporal's
 * at-least-once execution guarantee safe to rely on.
 */

/**
 * Context every activity log line carries, so a line can be traced back to the
 * workflow run and the retry attempt that produced it.
 */
function activityContext(): Record<string, unknown> {
  const { activityType, attempt, workflowExecution } = Context.current().info;
  return {
    activityType,
    attempt,
    workflowId: workflowExecution?.workflowId,
    runId: workflowExecution?.runId,
  };
}

/** Fetch Supplier A's hotels for a city and normalize them into offers. */
export async function fetchSupplierA(city: string): Promise<HotelOffer[]> {
  return fetchFromSupplier(SUPPLIER_A, config.suppliers.a.url, city);
}

/** Fetch Supplier B's hotels for a city and normalize them into offers. */
export async function fetchSupplierB(city: string): Promise<HotelOffer[]> {
  return fetchFromSupplier(SUPPLIER_B, config.suppliers.b.url, city);
}

/**
 * Persist the deduplicated list for a city as a price-scored sorted set.
 *
 * Idempotent by construction: the repository replaces the whole snapshot
 * rather than merging into it, so Temporal re-running this activity leaves
 * exactly the same state behind.
 */
export async function saveToRedis(city: string, offers: HotelOffer[]): Promise<number> {
  const ctx = activityContext();
  try {
    // The timestamp is generated here rather than in the workflow: activities
    // may read the clock, workflow code may not.
    const saved = await saveOffers(city, offers, new Date().toISOString());
    logger.info({ ...ctx, city, count: saved }, 'offers persisted to redis');
    return saved;
  } catch (cause) {
    // Log with context, then rethrow unchanged in kind so Temporal's retry
    // policy still applies — swallowing this would silently serve stale data.
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error({ ...ctx, city, err: message }, 'failed to persist offers to redis, will retry');
    throw new Error(`Could not cache offers for "${city}": ${message}`, { cause });
  }
}

async function fetchFromSupplier(supplier: SupplierId, baseUrl: string, city: string): Promise<HotelOffer[]> {
  const ctx = { ...activityContext(), supplier, city };
  const url = buildUrl(baseUrl, city);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(config.suppliers.timeoutMs),
    });
  } catch (cause) {
    // Network error or timeout: transient by nature, so let Temporal retry.
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.warn(
      { ...ctx, url, err: message, durationMs: Date.now() - startedAt },
      'supplier request failed, will retry',
    );
    throw new Error(`${supplier} request failed: ${message}`, { cause });
  }

  if (!response.ok) {
    const body = await safeText(response);
    // 4xx means we asked wrongly — retrying cannot help, so fail fast.
    if (response.status >= 400 && response.status < 500) {
      logger.error({ ...ctx, status: response.status, body }, 'supplier rejected the request, not retrying');
      throw ApplicationFailure.nonRetryable(
        `${supplier} rejected the request with ${response.status}`,
        'SupplierBadRequest',
        { supplier, status: response.status, body },
      );
    }
    logger.warn({ ...ctx, status: response.status, body }, 'supplier returned an error, will retry');
    throw new Error(`${supplier} returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw ApplicationFailure.nonRetryable(
      `${supplier} returned ${typeof payload}, expected an array`,
      'SupplierMalformedResponse',
      { supplier },
    );
  }

  // Drop individual malformed records rather than failing the whole city: one
  // bad row from a supplier should not deny the user every other offer.
  const raw: RawHotel[] = payload.filter(isRawHotel);
  if (raw.length !== payload.length) {
    logger.warn({ ...ctx, dropped: payload.length - raw.length }, 'discarded malformed supplier records');
  }

  const offers = raw.map((hotel) => toHotelOffer(hotel, supplier));
  logger.info({ ...ctx, count: offers.length, durationMs: Date.now() - startedAt }, 'supplier fetched');
  return offers;
}

function buildUrl(baseUrl: string, city: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('city', city);
  return url.toString();
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}

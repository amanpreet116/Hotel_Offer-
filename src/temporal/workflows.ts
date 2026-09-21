import { ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities.js';
import { dedupeAndSelectBest } from '../domain/dedupe.js';
import { SUPPLIER_A, SUPPLIER_B, type HotelOffer, type SupplierId } from '../domain/types.js';

/**
 * Orchestration only. No HTTP, no Redis, no clock, no randomness — everything
 * in here has to produce identical results on replay, so all I/O is delegated
 * to activities. `dedupeAndSelectBest` is pure, so it runs inline.
 */

const { fetchSupplierA, fetchSupplierB } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
    maximumAttempts: 3,
  },
});

const { saveToRedis } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '2 seconds',
    maximumAttempts: 3,
  },
});

export async function getHotelsWorkflow(city: string): Promise<HotelOffer[]> {
  log.info('aggregating hotel offers', { city });

  // Fan out to both suppliers at once. Settling each call separately (rather
  // than Promise.all, which rejects on the first failure) is what lets one
  // supplier being down degrade the result instead of failing the request.
  const [resultA, resultB] = await Promise.all([
    settle(SUPPLIER_A, fetchSupplierA(city)),
    settle(SUPPLIER_B, fetchSupplierB(city)),
  ]);

  if (!resultA.ok && !resultB.ok) {
    throw ApplicationFailure.nonRetryable(`Both suppliers failed for city "${city}"`, 'AllSuppliersUnavailable', {
      city,
      supplierA: resultA.error,
      supplierB: resultB.error,
    });
  }

  const degraded = !resultA.ok || !resultB.ok;
  const offers = dedupeAndSelectBest(resultA.offers, resultB.offers);

  // Cache even a partial snapshot: it is still the best data available, and
  // the alternative is serving nothing at all from the filtered endpoint.
  const saved = await saveToRedis(city, offers);

  log.info('aggregation complete', {
    city,
    supplierA: resultA.ok ? resultA.offers.length : 'unavailable',
    supplierB: resultB.ok ? resultB.offers.length : 'unavailable',
    deduped: offers.length,
    saved,
    degraded,
  });

  return offers;
}

/** A supplier call that has finished, successfully or not. */
type SupplierResult =
  | { readonly ok: true; readonly offers: HotelOffer[] }
  | { readonly ok: false; readonly offers: HotelOffer[]; readonly error: string };

/**
 * Await one supplier's activity, converting a failure into an empty result plus
 * a warning. Temporal has already exhausted the retry policy by the time we get
 * here, so a rejection means the supplier is genuinely unavailable.
 */
async function settle(supplier: SupplierId, pending: Promise<HotelOffer[]>): Promise<SupplierResult> {
  try {
    return { ok: true, offers: await pending };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn('supplier unavailable, continuing with the other supplier', { supplier, error });
    return { ok: false, offers: [], error };
  }
}

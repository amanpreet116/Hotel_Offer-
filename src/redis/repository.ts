import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { compareOffers } from '../domain/dedupe.js';
import type { HotelOffer, SupplierId } from '../domain/types.js';
import { getRedis } from './client.js';

/**
 * Persistence for a city's deduplicated offer list.
 *
 * The list lives in a sorted set scored by price, which is what makes price
 * filtering a server-side ZRANGEBYSCORE rather than a fetch-everything-then-
 * filter-in-JS round trip. Members are the serialized offers themselves, so a
 * range query returns finished results with no second lookup.
 *
 *   hotels:{city}        ZSET   score = price, member = JSON offer
 *   hotels:{city}:meta   STRING bookkeeping; also marks "this city is cached"
 *                               even when the city legitimately has 0 offers.
 */

export const NEGATIVE_INFINITY = '-inf';
export const POSITIVE_INFINITY = '+inf';

export interface CacheMeta {
  count: number;
  savedAt: string;
}

export function offersKey(city: string): string {
  return `${config.redis.keyPrefix}:${city}`;
}

export function metaKey(city: string): string {
  return `${config.redis.keyPrefix}:${city}:meta`;
}

/**
 * Replace a city's snapshot wholesale and give it a TTL.
 *
 * DEL + ZADD run in one MULTI so a concurrent reader sees either the old
 * snapshot or the new one, never a half-written set. Replacing rather than
 * merging is what keeps this activity idempotent under Temporal's
 * at-least-once execution.
 */
export async function saveOffers(city: string, offers: HotelOffer[], savedAt: string): Promise<number> {
  const redis = getRedis();
  const key = offersKey(city);
  const ttl = config.redis.ttlSeconds;

  const pipeline = redis.multi().del(key);

  if (offers.length > 0) {
    // ZADD takes flat score,member pairs.
    const scoredMembers = offers.flatMap((offer) => [offer.price, serializeOffer(offer)]);
    pipeline.zadd(key, ...scoredMembers);
    pipeline.expire(key, ttl);
  }

  const meta: CacheMeta = { count: offers.length, savedAt };
  pipeline.set(metaKey(city), JSON.stringify(meta), 'EX', ttl);

  await pipeline.exec();
  logger.info({ city, key, count: offers.length, ttlSeconds: ttl }, 'offers cached in redis');
  return offers.length;
}

/**
 * Whether this city has been aggregated recently.
 *
 * Deliberately keyed off the meta key, not the sorted set: a city with no
 * hotels has no sorted set at all, and we still want to remember that we
 * looked, instead of re-running the workflow on every request for it.
 */
export async function isCached(city: string): Promise<boolean> {
  return (await getRedis().exists(metaKey(city))) === 1;
}

export async function readMeta(city: string): Promise<CacheMeta | undefined> {
  const raw = await getRedis().get(metaKey(city));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as CacheMeta;
  } catch {
    return undefined;
  }
}

/**
 * Price-range query, answered inside Redis.
 *
 * `min`/`max` are passed straight to ZRANGEBYSCORE as scores, so Redis does
 * the filtering and returns only matching members. Both bounds are inclusive;
 * an omitted bound becomes -inf / +inf.
 */
export async function findByPriceRange(
  city: string,
  min: number | string = NEGATIVE_INFINITY,
  max: number | string = POSITIVE_INFINITY,
): Promise<HotelOffer[]> {
  const members = await getRedis().zrangebyscore(offersKey(city), min, max);
  return parseMembers(members, city).sort(compareOffers);
}

/** Drop a city's cache. Used by tests and by operational cleanup. */
export async function clearCity(city: string): Promise<void> {
  await getRedis().del(offersKey(city), metaKey(city));
}

export function serializeOffer(offer: HotelOffer): string {
  // Fixed key order so the same offer always produces the same member string —
  // otherwise a re-save could leave two members for one hotel.
  return JSON.stringify({
    name: offer.name,
    price: offer.price,
    supplier: offer.supplier,
    commissionPct: offer.commissionPct,
  });
}

/** Parse a stored member back into an offer, or undefined if it is unusable. */
export function parseOffer(member: string): HotelOffer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(member);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const candidate = value as Partial<Record<keyof HotelOffer, unknown>>;
  if (
    typeof candidate.name !== 'string' ||
    typeof candidate.price !== 'number' ||
    !Number.isFinite(candidate.price) ||
    (candidate.supplier !== 'Supplier A' && candidate.supplier !== 'Supplier B') ||
    typeof candidate.commissionPct !== 'number'
  ) {
    return undefined;
  }

  return {
    name: candidate.name,
    price: candidate.price,
    supplier: candidate.supplier satisfies SupplierId,
    commissionPct: candidate.commissionPct,
  };
}

function parseMembers(members: string[], city: string): HotelOffer[] {
  const offers: HotelOffer[] = [];
  for (const member of members) {
    const offer = parseOffer(member);
    if (offer === undefined) {
      logger.warn({ city, member: member.slice(0, 120) }, 'discarding unparseable cached offer');
      continue;
    }
    offers.push(offer);
  }
  return offers;
}

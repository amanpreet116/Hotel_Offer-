import { Router, type Request, type Response } from 'express';
import { logger } from '../../logger.js';
import { normalizeCity } from '../../suppliers/data.js';
import { runGetHotelsWorkflow } from '../../temporal/client.js';
import { NEGATIVE_INFINITY, POSITIVE_INFINITY, findByPriceRange, isCached } from '../../redis/repository.js';
import type { HotelOffer } from '../../domain/types.js';
import { ApiError } from '../errors.js';
import { asyncHandler } from '../async-handler.js';

/**
 * GET /api/hotels?city=delhi[&minPrice=&maxPrice=]
 *
 * Two paths, one result shape:
 *   - no price bounds -> run the Temporal workflow and return what it produced.
 *   - price bounds    -> answer from Redis with ZRANGEBYSCORE, running the
 *                        workflow first only if this city is not cached yet.
 *
 * The route itself holds no orchestration and no filtering logic: Temporal
 * owns the former, Redis the latter.
 */
export const hotelsRouter: Router = Router();

hotelsRouter.get(
  '/api/hotels',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const city = parseCity(req);
    const range = parsePriceRange(req);
    const requestId = res.locals['requestId'] as string | undefined;

    const offers = range === undefined ? await aggregate(city, requestId) : await queryRange(city, range, requestId);

    res.json(offers);
  }),
);

/** Run the workflow and return its deduplicated list. */
async function aggregate(city: string, requestId: string | undefined): Promise<HotelOffer[]> {
  const offers = await runGetHotelsWorkflow(city, requestId === undefined ? {} : { requestId });
  logger.debug({ city, requestId, count: offers.length, source: 'workflow' }, 'served offers');
  return offers;
}

/**
 * Serve a price range out of Redis.
 *
 * A cache miss runs the workflow purely for its side effect of populating
 * Redis — we deliberately query Redis afterwards rather than filtering the
 * workflow's return value in JS, so both the hit and miss paths are answered by
 * exactly the same ZRANGEBYSCORE.
 */
async function queryRange(city: string, range: PriceRange, requestId: string | undefined): Promise<HotelOffer[]> {
  const cached = await isCached(city);
  if (!cached) {
    logger.info({ city, requestId }, 'cache miss, running workflow to populate redis');
    await runGetHotelsWorkflow(city, requestId === undefined ? {} : { requestId });
  }

  const offers = await findByPriceRange(city, range.min, range.max);
  logger.debug(
    { city, requestId, min: range.min, max: range.max, count: offers.length, cached, source: 'redis' },
    'served offers',
  );
  return offers;
}

interface PriceRange {
  /** ZRANGEBYSCORE min: a number, or '-inf' when the bound was omitted. */
  min: number | string;
  /** ZRANGEBYSCORE max: a number, or '+inf' when the bound was omitted. */
  max: number | string;
}

function parseCity(req: Request): string {
  const raw = readQueryParam(req, 'city');
  if (raw === undefined) {
    throw ApiError.badRequest('city_required', 'Query parameter "city" is required, e.g. /api/hotels?city=delhi');
  }
  return normalizeCity(raw);
}

/** Returns undefined when neither bound was supplied. */
function parsePriceRange(req: Request): PriceRange | undefined {
  const rawMin = readQueryParam(req, 'minPrice');
  const rawMax = readQueryParam(req, 'maxPrice');
  if (rawMin === undefined && rawMax === undefined) return undefined;

  const min = parsePrice(rawMin, 'minPrice');
  const max = parsePrice(rawMax, 'maxPrice');

  if (min !== undefined && max !== undefined && min > max) {
    throw ApiError.badRequest('invalid_price_range', 'minPrice must be less than or equal to maxPrice', { min, max });
  }

  return { min: min ?? NEGATIVE_INFINITY, max: max ?? POSITIVE_INFINITY };
}

function parsePrice(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw ApiError.badRequest('invalid_price', `Query parameter "${field}" must be a number`, { [field]: raw });
  }
  if (parsed < 0) {
    throw ApiError.badRequest('invalid_price', `Query parameter "${field}" must not be negative`, { [field]: parsed });
  }
  return parsed;
}

/** Express query values can be arrays or nested objects; keep only plain strings. */
function readQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

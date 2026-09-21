import { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { SUPPLIER_A, SUPPLIER_B, type RawHotel, type SupplierId } from '../domain/types.js';
import { getSupplierHotels, normalizeCity } from './data.js';
import { asyncHandler } from '../api/async-handler.js';

/**
 * Mock supplier HTTP endpoints. These stand in for third-party APIs and are
 * mounted on the same Express app purely for convenience in this take-home —
 * the orchestrator always reaches them over HTTP (from a Temporal activity),
 * never by importing this module.
 *
 *   GET /supplierA/hotels?city=delhi
 *   GET /supplierB/hotels?city=delhi
 *
 * Two test affordances, both off by default:
 *   ?delayMs=   0-10000, simulates supplier latency — makes the difference
 *               between sequential and parallel fan-out visible.
 *   ?fail=1     responds 503, to exercise the workflow's graceful degradation
 *               without having to take a process down.
 */
export const supplierRouter: Router = Router();

supplierRouter.get('/supplierA/hotels', asyncHandler(makeSupplierHandler(SUPPLIER_A)));
supplierRouter.get('/supplierB/hotels', asyncHandler(makeSupplierHandler(SUPPLIER_B)));

function makeSupplierHandler(supplier: SupplierId) {
  return async (req: Request, res: Response): Promise<void> => {
    const city = normalizeCity(readQueryParam(req, 'city') ?? config.defaults.city);
    const delayMs = clampDelay(readQueryParam(req, 'delayMs'));

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (isTruthy(readQueryParam(req, 'fail'))) {
      logger.warn({ supplier, city }, 'supplier simulating an outage (?fail=1)');
      res.status(503).json({ error: 'supplier_unavailable', message: `${supplier} is down` });
      return;
    }

    const hotels: RawHotel[] = getSupplierHotels(supplier, city);
    logger.debug({ supplier, city, delayMs, count: hotels.length }, 'supplier responded');
    res.json(hotels);
  };
}

/** Express query values can be arrays or nested objects; keep only plain strings. */
function readQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' ? value : undefined;
}

function isTruthy(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function clampDelay(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

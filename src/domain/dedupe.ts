import type { HotelOffer } from './types.js';

/**
 * Merge two suppliers' offers into one catalogue, keeping the cheapest offer
 * per hotel name.
 *
 * Pure and framework-free on purpose: this is the one piece of business logic
 * that is safe to run inside Temporal workflow code, so it must have no I/O, no
 * clock, no randomness, and no dependency on iteration-order luck.
 *
 * Rules:
 *  - Hotels are matched by name, compared case-insensitively and trimmed, so
 *    "Holtin" and "holtin " collapse into one entry.
 *  - The cheaper price wins; the winning offer keeps its own supplier tag,
 *    commission and original display name.
 *  - Ties are broken deterministically by supplier id (ascending), so
 *    "Supplier A" wins an exact price tie regardless of argument order.
 *  - Hotels offered by only one supplier are kept as-is.
 *  - Output is sorted by name (then price) so the result is byte-for-byte
 *    reproducible — important for Temporal replay and for test assertions.
 */
export function dedupeAndSelectBest(a: HotelOffer[], b: HotelOffer[]): HotelOffer[] {
  const best = new Map<string, HotelOffer>();

  for (const offer of [...a, ...b]) {
    const key = normalizeName(offer.name);
    const incumbent = best.get(key);
    if (incumbent === undefined || isBetter(offer, incumbent)) {
      best.set(key, offer);
    }
  }

  return [...best.values()].sort(compareOffers);
}

/**
 * The canonical ordering for a list of offers. Exported so that offers read
 * back out of Redis come out in the same order as offers straight from the
 * workflow — the same query should not change shape depending on which path
 * answered it.
 */
export function compareOffers(x: HotelOffer, y: HotelOffer): number {
  return x.name.localeCompare(y.name) || x.price - y.price || x.supplier.localeCompare(y.supplier);
}

/** Grouping key: hotel names are matched ignoring case and surrounding space. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Strictly cheaper wins; an exact tie falls back to the lower supplier id. */
function isBetter(candidate: HotelOffer, incumbent: HotelOffer): boolean {
  if (candidate.price !== incumbent.price) return candidate.price < incumbent.price;
  return candidate.supplier.localeCompare(incumbent.supplier) < 0;
}

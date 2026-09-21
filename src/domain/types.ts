/**
 * The two mock suppliers we orchestrate over.
 *
 * These are the *display* names, because they appear verbatim in the API
 * response the spec pins down. The supplier HTTP routes are still spelled
 * `/supplierA/hotels` and `/supplierB/hotels` — don't collapse the two
 * spellings into one identifier.
 */
export type SupplierId = 'Supplier A' | 'Supplier B';

// `satisfies` rather than a type annotation: these must keep their literal
// types so they can be used as object keys typed by SupplierId.
export const SUPPLIER_A = 'Supplier A' satisfies SupplierId;
export const SUPPLIER_B = 'Supplier B' satisfies SupplierId;

/**
 * The shape a supplier's HTTP endpoint returns. This is the raw, per-supplier
 * record — it still carries supplier-internal fields (hotelId) and the city.
 */
export interface RawHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

/**
 * The normalized offer we reason about internally and return to clients — and
 * exactly the response shape the spec requires. `supplier` records which
 * supplier won this hotel after dedup.
 */
export interface HotelOffer {
  name: string;
  price: number;
  supplier: SupplierId;
  commissionPct: number;
}

/** Narrow an unknown value (a supplier's JSON) to a RawHotel. */
export function isRawHotel(value: unknown): value is RawHotel {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof RawHotel, unknown>>;
  return (
    typeof candidate.hotelId === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.price === 'number' &&
    Number.isFinite(candidate.price) &&
    typeof candidate.city === 'string' &&
    typeof candidate.commissionPct === 'number' &&
    Number.isFinite(candidate.commissionPct)
  );
}

/** Normalize a supplier's raw record into a comparable offer. */
export function toHotelOffer(raw: RawHotel, supplier: SupplierId): HotelOffer {
  return {
    name: raw.name,
    price: raw.price,
    supplier,
    commissionPct: raw.commissionPct,
  };
}

export function toHotelOffers(raws: readonly RawHotel[], supplier: SupplierId): HotelOffer[] {
  return raws.map((raw) => toHotelOffer(raw, supplier));
}

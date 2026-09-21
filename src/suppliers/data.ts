import { SUPPLIER_A, SUPPLIER_B, type RawHotel, type SupplierId } from '../domain/types.js';

/**
 * Static fixtures standing in for two real supplier APIs.
 *
 * The delhi data is the interesting case and is deliberately shaped to exercise
 * dedup:
 *   - Holtin           : B is cheaper  -> Supplier B wins
 *   - Radison          : A is cheaper  -> Supplier A wins
 *   - Leela Palace     : exact tie     -> Supplier A wins by the tie-break rule
 *   - Taj Mahal Hotel  : B is cheaper  -> Supplier B wins
 *   - 2 A-only and 2 B-only hotels pass through untouched.
 * Merging the two delhi lists (6 + 6) must yield exactly 8 offers.
 */

const SUPPLIER_A_HOTELS: Readonly<Record<string, readonly RawHotel[]>> = {
  delhi: [
    { hotelId: 'A-DEL-001', name: 'Holtin', price: 5200, city: 'delhi', commissionPct: 12 },
    { hotelId: 'A-DEL-002', name: 'Radison', price: 6100, city: 'delhi', commissionPct: 10 },
    { hotelId: 'A-DEL-003', name: 'Leela Palace', price: 9800, city: 'delhi', commissionPct: 15 },
    { hotelId: 'A-DEL-004', name: 'Taj Mahal Hotel', price: 12400, city: 'delhi', commissionPct: 8 },
    { hotelId: 'A-DEL-005', name: 'The Imperial', price: 8700, city: 'delhi', commissionPct: 11 },
    { hotelId: 'A-DEL-006', name: 'Bloomrooms Janpath', price: 3100, city: 'delhi', commissionPct: 18 },
  ],
  mumbai: [
    { hotelId: 'A-BOM-001', name: 'Holtin', price: 6200, city: 'mumbai', commissionPct: 12 },
    { hotelId: 'A-BOM-002', name: 'Trident Nariman Point', price: 11500, city: 'mumbai', commissionPct: 9 },
    { hotelId: 'A-BOM-003', name: 'Sea Princess', price: 4800, city: 'mumbai', commissionPct: 16 },
    { hotelId: 'A-BOM-004', name: 'Hotel Marine Plaza', price: 7300, city: 'mumbai', commissionPct: 13 },
  ],
};

const SUPPLIER_B_HOTELS: Readonly<Record<string, readonly RawHotel[]>> = {
  delhi: [
    { hotelId: 'B-DEL-101', name: 'Holtin', price: 4950, city: 'delhi', commissionPct: 9 },
    { hotelId: 'B-DEL-102', name: 'Radison', price: 6400, city: 'delhi', commissionPct: 14 },
    { hotelId: 'B-DEL-103', name: 'Leela Palace', price: 9800, city: 'delhi', commissionPct: 12 },
    { hotelId: 'B-DEL-104', name: 'Taj Mahal Hotel', price: 11900, city: 'delhi', commissionPct: 7 },
    { hotelId: 'B-DEL-105', name: 'Hyatt Regency', price: 7250, city: 'delhi', commissionPct: 13 },
    { hotelId: 'B-DEL-106', name: 'Andaz Delhi', price: 10500, city: 'delhi', commissionPct: 10 },
  ],
  mumbai: [
    { hotelId: 'B-BOM-101', name: 'Holtin', price: 5900, city: 'mumbai', commissionPct: 10 },
    { hotelId: 'B-BOM-102', name: 'Trident Nariman Point', price: 11500, city: 'mumbai', commissionPct: 11 },
    { hotelId: 'B-BOM-103', name: 'The Oberoi', price: 15200, city: 'mumbai', commissionPct: 6 },
    { hotelId: 'B-BOM-104', name: 'Bloomrooms Andheri', price: 3600, city: 'mumbai', commissionPct: 19 },
  ],
};

const CATALOGUE: Readonly<Record<SupplierId, Readonly<Record<string, readonly RawHotel[]>>>> = {
  [SUPPLIER_A]: SUPPLIER_A_HOTELS,
  [SUPPLIER_B]: SUPPLIER_B_HOTELS,
};

/** Look up a supplier's hotels for a city. Unknown cities return an empty list. */
export function getSupplierHotels(supplier: SupplierId, city: string): RawHotel[] {
  const byCity = CATALOGUE[supplier];
  const hotels = byCity[normalizeCity(city)];
  return hotels === undefined ? [] : hotels.map((hotel) => ({ ...hotel }));
}

export function normalizeCity(city: string): string {
  return city.trim().toLowerCase();
}

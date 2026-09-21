import { describe, expect, it } from 'vitest';
import { dedupeAndSelectBest } from '../src/domain/dedupe.js';
import { toHotelOffers } from '../src/domain/types.js';
import { getSupplierHotels } from '../src/suppliers/data.js';
import type { HotelOffer } from '../src/domain/types.js';

const offer = (name: string, price: number, supplier: HotelOffer['supplier'], commissionPct = 10): HotelOffer => ({
  name,
  price,
  supplier,
  commissionPct,
});

describe('dedupeAndSelectBest', () => {
  describe('hotel offered by both suppliers', () => {
    it('keeps the cheaper offer when Supplier B is cheaper', () => {
      const result = dedupeAndSelectBest([offer('Holtin', 5200, 'Supplier A')], [offer('Holtin', 4950, 'Supplier B')]);
      expect(result).toEqual([offer('Holtin', 4950, 'Supplier B')]);
    });

    it('keeps the cheaper offer when Supplier A is cheaper', () => {
      const result = dedupeAndSelectBest(
        [offer('Radison', 6100, 'Supplier A')],
        [offer('Radison', 6400, 'Supplier B')],
      );
      expect(result).toEqual([offer('Radison', 6100, 'Supplier A')]);
    });

    it('collapses the overlap into a single entry', () => {
      const result = dedupeAndSelectBest([offer('Holtin', 5200, 'Supplier A')], [offer('Holtin', 4950, 'Supplier B')]);
      expect(result).toHaveLength(1);
    });

    it('carries the winning offer commission through, not the loser one', () => {
      const result = dedupeAndSelectBest(
        [offer('Taj Mahal Hotel', 12400, 'Supplier A', 8)],
        [offer('Taj Mahal Hotel', 11900, 'Supplier B', 7)],
      );
      expect(result[0]?.commissionPct).toBe(7);
    });

    it('matches names case-insensitively and ignores surrounding whitespace', () => {
      const result = dedupeAndSelectBest(
        [offer('Radison', 6100, 'Supplier A')],
        [offer(' radison ', 5000, 'Supplier B')],
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.supplier).toBe('Supplier B');
    });
  });

  describe('exact price tie', () => {
    it('resolves to Supplier A regardless of argument order', () => {
      const a = [offer('Leela Palace', 9800, 'Supplier A', 15)];
      const b = [offer('Leela Palace', 9800, 'Supplier B', 12)];
      expect(dedupeAndSelectBest(a, b)).toEqual(a);
      expect(dedupeAndSelectBest(b, a)).toEqual(a);
    });

    it('is stable across repeated runs', () => {
      const a = [offer('Leela Palace', 9800, 'Supplier A')];
      const b = [offer('Leela Palace', 9800, 'Supplier B')];
      const runs = Array.from({ length: 5 }, () => dedupeAndSelectBest(a, b));
      for (const run of runs) expect(run).toEqual(runs[0]);
    });
  });

  describe('hotel offered by one supplier only', () => {
    it('keeps an A-only hotel', () => {
      const result = dedupeAndSelectBest([offer('The Imperial', 8700, 'Supplier A')], []);
      expect(result).toEqual([offer('The Imperial', 8700, 'Supplier A')]);
    });

    it('keeps a B-only hotel', () => {
      const result = dedupeAndSelectBest([], [offer('Andaz Delhi', 10500, 'Supplier B')]);
      expect(result).toEqual([offer('Andaz Delhi', 10500, 'Supplier B')]);
    });

    it('keeps A-only and B-only hotels side by side', () => {
      const result = dedupeAndSelectBest(
        [offer('The Imperial', 8700, 'Supplier A')],
        [offer('Andaz Delhi', 10500, 'Supplier B')],
      );
      expect(result.map((o) => o.name)).toEqual(['Andaz Delhi', 'The Imperial']);
    });
  });

  describe('empty inputs', () => {
    it('returns an empty list when both suppliers return nothing', () => {
      expect(dedupeAndSelectBest([], [])).toEqual([]);
    });

    it('returns the other supplier list when one is empty', () => {
      expect(dedupeAndSelectBest([], [offer('Hyatt Regency', 7250, 'Supplier B')])).toHaveLength(1);
      expect(dedupeAndSelectBest([offer('Hyatt Regency', 7250, 'Supplier A')], [])).toHaveLength(1);
    });
  });

  describe('output ordering', () => {
    it('is sorted by name so results are reproducible across replays', () => {
      const result = dedupeAndSelectBest(
        [offer('Zebra Inn', 100, 'Supplier A'), offer('Alpha Inn', 200, 'Supplier A')],
        [offer('Mid Inn', 150, 'Supplier B')],
      );
      expect(result.map((o) => o.name)).toEqual(['Alpha Inn', 'Mid Inn', 'Zebra Inn']);
    });
  });

  describe('against the shipped fixtures', () => {
    it('merges the delhi lists into 8 offers with the expected winners', () => {
      const a = toHotelOffers(getSupplierHotels('Supplier A', 'delhi'), 'Supplier A');
      const b = toHotelOffers(getSupplierHotels('Supplier B', 'delhi'), 'Supplier B');

      const result = dedupeAndSelectBest(a, b);

      expect(result).toHaveLength(8);
      expect(Object.fromEntries(result.map((o) => [o.name, `${o.supplier}@${o.price}`]))).toMatchObject({
        Holtin: 'Supplier B@4950',
        Radison: 'Supplier A@6100',
        'Leela Palace': 'Supplier A@9800',
        'Taj Mahal Hotel': 'Supplier B@11900',
        'The Imperial': 'Supplier A@8700',
        'Andaz Delhi': 'Supplier B@10500',
      });
    });

    it('never produces a duplicate hotel name', () => {
      const a = toHotelOffers(getSupplierHotels('Supplier A', 'delhi'), 'Supplier A');
      const b = toHotelOffers(getSupplierHotels('Supplier B', 'delhi'), 'Supplier B');

      const names = dedupeAndSelectBest(a, b).map((o) => o.name);

      expect(new Set(names).size).toBe(names.length);
    });

    it('returns nothing for an unknown city', () => {
      expect(getSupplierHotels('Supplier A', 'jaipur')).toEqual([]);
      expect(getSupplierHotels('Supplier B', 'jaipur')).toEqual([]);
    });
  });
});

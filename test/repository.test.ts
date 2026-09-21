import { describe, expect, it } from 'vitest';
import { parseOffer, serializeOffer } from '../src/redis/repository.js';
import type { HotelOffer } from '../src/domain/types.js';

/**
 * Serialization is what a sorted-set member is made of, so a change here
 * silently corrupts every cached city. These tests need no Redis.
 */
describe('offer serialization', () => {
  const offer: HotelOffer = { name: 'Holtin', price: 4950, supplier: 'Supplier B', commissionPct: 9 };

  it('round-trips an offer', () => {
    expect(parseOffer(serializeOffer(offer))).toEqual(offer);
  });

  it('serializes keys in a fixed order regardless of construction order', () => {
    const reordered = { commissionPct: 9, supplier: 'Supplier B', price: 4950, name: 'Holtin' } as HotelOffer;
    expect(serializeOffer(reordered)).toBe(serializeOffer(offer));
  });

  it('rejects members that are not valid offers', () => {
    expect(parseOffer('not json')).toBeUndefined();
    expect(parseOffer('null')).toBeUndefined();
    expect(parseOffer('[1,2,3]')).toBeUndefined();
    expect(parseOffer(JSON.stringify({ ...offer, price: 'free' }))).toBeUndefined();
    expect(parseOffer(JSON.stringify({ ...offer, supplier: 'Supplier C' }))).toBeUndefined();
    expect(parseOffer(JSON.stringify({ name: 'Holtin' }))).toBeUndefined();
  });
});

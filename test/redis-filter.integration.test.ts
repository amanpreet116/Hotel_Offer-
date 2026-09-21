import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HotelOffer } from '../src/domain/types.js';

/**
 * Integration test for the in-Redis price filter.
 *
 * Exercises the real ZRANGEBYSCORE path against a real Redis — the thing unit
 * tests cannot cover, because the filtering happens server-side.
 *
 * Skips itself when no Redis is reachable, so `npm test` stays green on a
 * machine with nothing running. Start one with `docker compose up -d redis`.
 */

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TEST_PREFIX = 'test-hotels';

// Set before the repository is imported: config reads the environment once, at
// module load. An isolated prefix keeps this test from touching real data even
// if it is pointed at a shared Redis.
process.env['REDIS_KEY_PREFIX'] = TEST_PREFIX;
process.env['REDIS_TTL_SECONDS'] = '60';

const reachable = await isRedisReachable(REDIS_URL);
const describeIfRedis = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn(`[skip] No Redis at ${REDIS_URL} — skipping the ZRANGEBYSCORE integration test.`);
}

const offer = (name: string, price: number, supplier: HotelOffer['supplier'], commissionPct = 10): HotelOffer => ({
  name,
  price,
  supplier,
  commissionPct,
});

// The deduplicated delhi catalogue, the same data the workflow would cache.
const DELHI: HotelOffer[] = [
  offer('Bloomrooms Janpath', 3100, 'Supplier A', 18),
  offer('Holtin', 4950, 'Supplier B', 9),
  offer('Radison', 6100, 'Supplier A', 10),
  offer('Hyatt Regency', 7250, 'Supplier B', 13),
  offer('The Imperial', 8700, 'Supplier A', 11),
  offer('Leela Palace', 9800, 'Supplier A', 15),
  offer('Andaz Delhi', 10500, 'Supplier B', 10),
  offer('Taj Mahal Hotel', 11900, 'Supplier B', 7),
];

describeIfRedis('price filtering inside Redis (ZRANGEBYSCORE)', () => {
  type Repo = typeof import('../src/redis/repository.js');
  type Client = typeof import('../src/redis/client.js');

  let repo: Repo;
  let client: Client;
  const city = 'testcity';

  beforeAll(async () => {
    repo = await import('../src/redis/repository.js');
    client = await import('../src/redis/client.js');
    await repo.clearCity(city);
    await repo.saveOffers(city, DELHI, new Date().toISOString());
  });

  afterAll(async () => {
    await repo.clearCity(city);
    await repo.clearCity('emptycity');
    await client.closeRedis();
  });

  it('stores the offers in a sorted set scored by price', async () => {
    const redis = client.getRedis();
    const key = repo.offersKey(city);

    expect(await redis.type(key)).toBe('zset');
    expect(await redis.zcard(key)).toBe(DELHI.length);

    // Redis returns members in score order, which must be price order.
    const withScores = await redis.zrange(key, 0, -1, 'WITHSCORES');
    const scores = withScores.filter((_value, index) => index % 2 === 1).map(Number);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(scores).toEqual(DELHI.map((o) => o.price).sort((a, b) => a - b));
  });

  it('filters by an inclusive price range', async () => {
    const result = await repo.findByPriceRange(city, 4000, 9000);

    expect(result.map((o) => o.name).sort()).toEqual(['Holtin', 'Hyatt Regency', 'Radison', 'The Imperial']);
    for (const o of result) expect(o.price).toBeGreaterThanOrEqual(4000);
    for (const o of result) expect(o.price).toBeLessThanOrEqual(9000);
  });

  it('includes offers priced exactly on each bound', async () => {
    const result = await repo.findByPriceRange(city, 4950, 8700);

    expect(result.map((o) => o.price)).toContain(4950);
    expect(result.map((o) => o.price)).toContain(8700);
  });

  it('treats an omitted bound as -inf / +inf', async () => {
    const atLeast = await repo.findByPriceRange(city, 9000, repo.POSITIVE_INFINITY);
    expect(atLeast.map((o) => o.name).sort()).toEqual(['Andaz Delhi', 'Leela Palace', 'Taj Mahal Hotel']);

    const atMost = await repo.findByPriceRange(city, repo.NEGATIVE_INFINITY, 5000);
    expect(atMost.map((o) => o.name).sort()).toEqual(['Bloomrooms Janpath', 'Holtin']);

    const all = await repo.findByPriceRange(city);
    expect(all).toHaveLength(DELHI.length);
  });

  it('returns an empty list for a range no hotel falls into', async () => {
    // The real gap in the fixture data: prices jump 4950 -> 6100.
    expect(await repo.findByPriceRange(city, 5000, 6000)).toEqual([]);
  });

  it('round-trips offers with their supplier and commission intact', async () => {
    const [holtin] = await repo.findByPriceRange(city, 4950, 4950);

    expect(holtin).toEqual(offer('Holtin', 4950, 'Supplier B', 9));
  });

  it('never returns a duplicate hotel name', async () => {
    const names = (await repo.findByPriceRange(city)).map((o) => o.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('returns results in the same order as the workflow does', async () => {
    const fromRedis = await repo.findByPriceRange(city);
    const { dedupeAndSelectBest } = await import('../src/domain/dedupe.js');

    // Feeding the same offers through the pure path must produce an identical
    // list, so a client cannot tell which path served the request.
    expect(fromRedis).toEqual(dedupeAndSelectBest(DELHI, []));
  });

  it('replaces the snapshot on refresh instead of appending to it', async () => {
    const cheaper = DELHI.map((o) => ({ ...o, price: o.price - 100 }));
    await repo.saveOffers(city, cheaper, new Date().toISOString());

    const redis = client.getRedis();
    expect(await redis.zcard(repo.offersKey(city))).toBe(DELHI.length);
    expect(await repo.findByPriceRange(city, 4850, 4850)).toHaveLength(1);

    // Restore for any later assertions.
    await repo.saveOffers(city, DELHI, new Date().toISOString());
  });

  it('sets a TTL on both the sorted set and its marker', async () => {
    const redis = client.getRedis();

    expect(await redis.ttl(repo.offersKey(city))).toBeGreaterThan(0);
    expect(await redis.ttl(repo.metaKey(city))).toBeGreaterThan(0);
  });

  it('marks a city with no hotels as cached, without creating a sorted set', async () => {
    await repo.saveOffers('emptycity', [], new Date().toISOString());

    expect(await repo.isCached('emptycity')).toBe(true);
    expect(await client.getRedis().exists(repo.offersKey('emptycity'))).toBe(0);
    expect(await repo.findByPriceRange('emptycity', 0, 999999)).toEqual([]);
    expect((await repo.readMeta('emptycity'))?.count).toBe(0);
  });

  it('reports an unknown city as not cached', async () => {
    expect(await repo.isCached('never-aggregated')).toBe(false);
  });
});

async function isRedisReachable(url: string): Promise<boolean> {
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

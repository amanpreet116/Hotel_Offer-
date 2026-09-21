import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/api/openapi.js';
import { SUPPLIER_A, SUPPLIER_B } from '../src/domain/types.js';
import type { HotelOffer, RawHotel } from '../src/domain/types.js';

/**
 * The OpenAPI document is hand-written, so these tests guard the two ways it
 * can silently drift: an unresolvable $ref, and a schema that no longer matches
 * the TypeScript types it claims to describe.
 */
describe('OpenAPI document', () => {
  it('declares the expected identity and a server built from the configured port', () => {
    expect(openApiDocument.openapi).toMatch(/^3\.0/);
    expect(openApiDocument.info.title).toBe('Hotel Offer Orchestrator');
    expect(openApiDocument.info.version).toBeTruthy();
    expect(openApiDocument.info.description).toBeTruthy();
    // The first server must be relative, so Swagger UI's "Try it out" targets
    // whatever origin serves the docs rather than a port that may not be
    // published.
    expect(openApiDocument.servers?.[0]?.url).toBe('/');
    expect(openApiDocument.servers?.[1]?.url).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it('documents every endpoint the service exposes, under the expected tags', () => {
    expect(Object.keys(openApiDocument.paths).sort()).toEqual([
      '/api/hotels',
      '/health',
      '/supplierA/hotels',
      '/supplierB/hotels',
    ]);

    expect(openApiDocument.tags?.map((t) => t.name)).toEqual(['Hotels', 'Health', 'Suppliers (mock)']);

    const declared = new Set(openApiDocument.tags?.map((t) => t.name));
    for (const [path, item] of Object.entries(openApiDocument.paths)) {
      for (const tag of item?.get?.tags ?? []) {
        expect(declared, `${path} uses an undeclared tag`).toContain(tag);
      }
    }
  });

  it('gives every operation an id, a summary and a 200-level response', () => {
    for (const [path, item] of Object.entries(openApiDocument.paths)) {
      const op = item?.get;
      expect(op?.operationId, `${path} is missing operationId`).toBeTruthy();
      expect(op?.summary, `${path} is missing summary`).toBeTruthy();
      expect(op?.responses['200'], `${path} is missing a 200 response`).toBeDefined();
    }
  });

  it('resolves every $ref against components/schemas', () => {
    const schemas = openApiDocument.components?.schemas ?? {};
    const refs = [...JSON.stringify(openApiDocument).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, `unexpected $ref form: ${ref ?? ''}`).toMatch(/^#\/components\/schemas\//);
      const name = ref?.replace('#/components/schemas/', '') ?? '';
      expect(Object.keys(schemas), `dangling $ref: ${ref ?? ''}`).toContain(name);
    }
  });

  it('keeps the HotelOffer schema in step with the HotelOffer type', () => {
    // Fails to compile if a field is added to or removed from HotelOffer.
    const sample: Record<keyof HotelOffer, true> = {
      name: true,
      price: true,
      supplier: true,
      commissionPct: true,
    };
    const schema = openApiDocument.components?.schemas?.['HotelOffer'];

    expect(schema && 'properties' in schema ? Object.keys(schema.properties ?? {}).sort() : []).toEqual(
      Object.keys(sample).sort(),
    );
    expect(schema && 'required' in schema ? [...(schema.required ?? [])].sort() : []).toEqual(
      Object.keys(sample).sort(),
    );
  });

  it('keeps the RawHotel schema in step with the RawHotel type', () => {
    const sample: Record<keyof RawHotel, true> = {
      hotelId: true,
      name: true,
      price: true,
      city: true,
      commissionPct: true,
    };
    const schema = openApiDocument.components?.schemas?.['RawHotel'];

    expect(schema && 'properties' in schema ? Object.keys(schema.properties ?? {}).sort() : []).toEqual(
      Object.keys(sample).sort(),
    );
  });

  it('documents exactly the supplier names the domain uses', () => {
    const schema = openApiDocument.components?.schemas?.['HotelOffer'];
    const supplier = schema && 'properties' in schema ? schema.properties?.['supplier'] : undefined;
    const values = supplier && 'enum' in supplier ? supplier.enum : undefined;

    expect(values).toEqual([SUPPLIER_A, SUPPLIER_B]);
  });

  it('documents that an unknown city is a 200 with an empty array, not an error', () => {
    const ok = openApiDocument.paths['/api/hotels']?.get?.responses['200'];
    const examples = ok && 'content' in ok ? ok.content?.['application/json']?.examples : undefined;
    const unknownCity = examples?.['unknownCity'];

    const value: unknown = unknownCity && 'value' in unknownCity ? unknownCity.value : undefined;
    expect(value).toEqual([]);
  });

  it('documents the 400 error body shape for an invalid price range', () => {
    const bad = openApiDocument.paths['/api/hotels']?.get?.responses['400'];
    const examples = bad && 'content' in bad ? bad.content?.['application/json']?.examples : undefined;
    const invalidRange = examples?.['invalidRange'];
    const value: unknown = invalidRange && 'value' in invalidRange ? invalidRange.value : undefined;

    expect(value).toMatchObject({ error: 'invalid_price_range' });
  });

  it('marks city required and the price bounds optional', () => {
    const params = openApiDocument.paths['/api/hotels']?.get?.parameters ?? [];
    const byName = new Map(
      params.filter((p): p is Exclude<typeof p, { $ref: string }> => !('$ref' in p)).map((p) => [p.name, p]),
    );

    expect(byName.get('city')?.required).toBe(true);
    expect(byName.get('minPrice')?.required).toBe(false);
    expect(byName.get('maxPrice')?.required).toBe(false);
  });
});

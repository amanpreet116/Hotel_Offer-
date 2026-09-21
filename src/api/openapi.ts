import type { OpenAPIV3 } from 'openapi-types';
import { config } from '../config/index.js';

/**
 * The single source of truth for the API contract.
 *
 * Deliberately one typed object rather than JSDoc annotations scattered across
 * route files: annotations sit next to code that changes for unrelated reasons
 * and drift out of sync silently. Typing it as OpenAPIV3.Document means a
 * malformed spec is a compile error, not a broken docs page.
 *
 * This module is documentation only — it imports no Temporal or Redis code and
 * nothing imports it except the Express app.
 */

const HOTEL_OFFER_EXAMPLE = [
  { name: 'Holtin', price: 4950, supplier: 'Supplier B', commissionPct: 9 },
  { name: 'Radison', price: 6100, supplier: 'Supplier A', commissionPct: 10 },
];

const DELHI_FULL_EXAMPLE = [
  { name: 'Andaz Delhi', price: 10500, supplier: 'Supplier B', commissionPct: 10 },
  { name: 'Bloomrooms Janpath', price: 3100, supplier: 'Supplier A', commissionPct: 18 },
  { name: 'Holtin', price: 4950, supplier: 'Supplier B', commissionPct: 9 },
  { name: 'Hyatt Regency', price: 7250, supplier: 'Supplier B', commissionPct: 13 },
  { name: 'Leela Palace', price: 9800, supplier: 'Supplier A', commissionPct: 15 },
  { name: 'Radison', price: 6100, supplier: 'Supplier A', commissionPct: 10 },
  { name: 'Taj Mahal Hotel', price: 11900, supplier: 'Supplier B', commissionPct: 7 },
  { name: 'The Imperial', price: 8700, supplier: 'Supplier A', commissionPct: 11 },
];

const schemas: Record<string, OpenAPIV3.SchemaObject> = {
  HotelOffer: {
    type: 'object',
    description:
      'A deduplicated offer: the cheaper of the two suppliers for a given hotel name, tagged with the supplier that won.',
    required: ['name', 'price', 'supplier', 'commissionPct'],
    properties: {
      name: { type: 'string', description: 'Hotel name, used as the deduplication key.', example: 'Holtin' },
      price: { type: 'number', description: 'The winning (cheaper) price.', example: 4950 },
      supplier: {
        type: 'string',
        enum: ['Supplier A', 'Supplier B'],
        description: 'Which supplier offered the winning price.',
        example: 'Supplier B',
      },
      commissionPct: {
        type: 'number',
        description: "Commission percentage from the winning supplier's offer.",
        example: 9,
      },
    },
    example: HOTEL_OFFER_EXAMPLE[0],
  },

  RawHotel: {
    type: 'object',
    description: 'An unnormalized record as returned by a supplier feed, before deduplication.',
    required: ['hotelId', 'name', 'price', 'city', 'commissionPct'],
    properties: {
      hotelId: { type: 'string', description: "The supplier's own identifier.", example: 'A-DEL-001' },
      name: { type: 'string', example: 'Holtin' },
      price: { type: 'number', example: 5200 },
      city: { type: 'string', example: 'delhi' },
      commissionPct: { type: 'number', example: 12 },
    },
  },

  DependencyStatus: {
    type: 'object',
    description: 'The result of one live dependency probe.',
    required: ['status', 'latencyMs'],
    properties: {
      status: { type: 'string', enum: ['up', 'down'], example: 'up' },
      latencyMs: { type: 'number', description: 'How long the probe took.', example: 9 },
      error: {
        type: 'string',
        description: 'Why the probe failed. Absent when the dependency is up.',
        example: 'HTTP 503',
      },
    },
  },

  HealthResponse: {
    type: 'object',
    description: 'Live probe results for every dependency.',
    required: ['status', 'suppliers', 'redis', 'temporal', 'checkedAt', 'uptimeSeconds'],
    properties: {
      status: {
        type: 'string',
        enum: ['ok', 'degraded', 'down'],
        description:
          '`ok` — everything reachable. `degraded` — one supplier down, still serving from the other. `down` — Redis or Temporal down, or both suppliers down.',
        example: 'ok',
      },
      suppliers: {
        type: 'object',
        required: ['A', 'B'],
        properties: {
          A: { $ref: '#/components/schemas/DependencyStatus' },
          B: { $ref: '#/components/schemas/DependencyStatus' },
        },
      },
      redis: { $ref: '#/components/schemas/DependencyStatus' },
      temporal: { $ref: '#/components/schemas/DependencyStatus' },
      checkedAt: { type: 'string', format: 'date-time', example: '2026-09-21T10:17:57.742Z' },
      uptimeSeconds: { type: 'number', example: 21 },
    },
  },

  ErrorResponse: {
    type: 'object',
    description: 'The single error shape used by every failing endpoint.',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string', description: 'Stable machine-readable code.', example: 'invalid_price_range' },
      message: { type: 'string', example: 'minPrice must be less than or equal to maxPrice' },
      details: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional context about the failure.',
        example: { min: 9000, max: 4000 },
      },
    },
  },
};

export const openApiDocument: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'Hotel Offer Orchestrator',
    version: '1.0.0',
    description:
      'Aggregates overlapping hotel offers from two suppliers, deduplicates them by hotel name keeping the ' +
      'cheaper price, and serves price-range queries filtered inside Redis.\n\n' +
      'The two supplier calls fan out in parallel inside a Temporal workflow. If one supplier is down the ' +
      'request still succeeds using the other supplier’s offers; only a failure of both is an error.',
  },
  servers: [
    {
      // Relative, and listed first so Swagger UI picks it by default: "Try it
      // out" then targets whatever origin is serving the docs. An absolute URL
      // built from PORT would be wrong the moment the container port is
      // published on a different host port (compose's API_HOST_PORT).
      url: '/',
      description: 'This instance (same origin as these docs)',
    },
    {
      url: `http://localhost:${String(config.api.port)}`,
      description: `Configured PORT (${String(config.api.port)})`,
    },
  ],
  tags: [
    { name: 'Hotels', description: 'The aggregated, deduplicated catalogue.' },
    { name: 'Health', description: 'Live dependency probes.' },
    {
      name: 'Suppliers (mock)',
      description:
        'Stand-ins for third-party supplier APIs, hosted by this service. The orchestrator always reaches ' +
        'them over HTTP from a Temporal activity.',
    },
  ],
  paths: {
    '/api/hotels': {
      get: {
        tags: ['Hotels'],
        summary: 'Get the deduplicated best-price catalogue for a city',
        description:
          'Runs a Temporal workflow that calls both suppliers **in parallel**, deduplicates by hotel name ' +
          'keeping the cheaper offer, caches the result in Redis, and returns it.\n\n' +
          'When `minPrice` and/or `maxPrice` are supplied, the filtering is **served from Redis** via ' +
          '`ZRANGEBYSCORE` over a sorted set scored by price — the catalogue is never loaded into the ' +
          'process and filtered in JavaScript. If the city is not cached yet, the workflow runs first to ' +
          'populate Redis and the same range query then answers the request.\n\n' +
          'Names are matched trimmed and case-insensitively. An exact price tie resolves to Supplier A ' +
          'deterministically. A hotel offered by only one supplier is kept as is.\n\n' +
          'An **unknown city is not an error** — it returns `200` with an empty array.\n\n' +
          'Populated cities in the mock data: `delhi` (8 offers) and `mumbai` (6 offers).',
        operationId: 'getHotels',
        parameters: [
          {
            name: 'city',
            in: 'query',
            required: true,
            description: 'City to aggregate. Case-insensitive. An unknown city returns `[]`.',
            schema: { type: 'string', example: 'delhi' },
          },
          {
            name: 'minPrice',
            in: 'query',
            required: false,
            description: 'Inclusive lower bound. Omit for no lower bound (`-inf`).',
            schema: { type: 'number', minimum: 0, example: 4000 },
          },
          {
            name: 'maxPrice',
            in: 'query',
            required: false,
            description: 'Inclusive upper bound. Omit for no upper bound (`+inf`).',
            schema: { type: 'number', minimum: 0, example: 9000 },
          },
        ],
        responses: {
          '200': {
            description:
              'The deduplicated catalogue, sorted by hotel name. No name appears twice. Empty array for an unknown city.',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/HotelOffer' } },
                examples: {
                  delhi: {
                    summary: 'city=delhi — 6 + 6 supplier hotels merged into 8 offers',
                    value: DELHI_FULL_EXAMPLE,
                  },
                  filtered: {
                    summary: 'city=delhi&minPrice=4000&maxPrice=9000 — filtered inside Redis',
                    value: [
                      { name: 'Holtin', price: 4950, supplier: 'Supplier B', commissionPct: 9 },
                      { name: 'Hyatt Regency', price: 7250, supplier: 'Supplier B', commissionPct: 13 },
                      { name: 'Radison', price: 6100, supplier: 'Supplier A', commissionPct: 10 },
                      { name: 'The Imperial', price: 8700, supplier: 'Supplier A', commissionPct: 11 },
                    ],
                  },
                  unknownCity: {
                    summary: 'city=atlantis — unknown city is not an error',
                    value: [],
                  },
                },
              },
            },
          },
          '400': {
            description: 'Missing city, a non-numeric or negative bound, or `minPrice` greater than `maxPrice`.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                examples: {
                  cityRequired: {
                    summary: 'city omitted',
                    value: {
                      error: 'city_required',
                      message: 'Query parameter "city" is required, e.g. /api/hotels?city=delhi',
                    },
                  },
                  invalidPrice: {
                    summary: 'minPrice is not a number',
                    value: {
                      error: 'invalid_price',
                      message: 'Query parameter "minPrice" must be a number',
                      details: { minPrice: 'abc' },
                    },
                  },
                  invalidRange: {
                    summary: 'minPrice greater than maxPrice',
                    value: {
                      error: 'invalid_price_range',
                      message: 'minPrice must be less than or equal to maxPrice',
                      details: { min: 9000, max: 4000 },
                    },
                  },
                },
              },
            },
          },
          '502': {
            description:
              'Both suppliers were unavailable, so nothing could be aggregated, or the workflow failed for another reason. ' +
              'One supplier failing is **not** an error — see the description above.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'suppliers_unavailable',
                  message: 'Both suppliers are unavailable; no offers could be aggregated',
                },
              },
            },
          },
          '503': {
            description: 'Redis or Temporal is unreachable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                example: {
                  error: 'redis_unavailable',
                  message: 'Redis is not reachable; cached offers could not be read or written',
                },
              },
            },
          },
        },
      },
    },

    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Live dependency probes',
        description:
          'Actively probes **both suppliers, Redis and Temporal** on every call — nothing is cached or ' +
          'inferred from configuration. All four probes run concurrently, so the endpoint costs one ' +
          'timeout at worst.\n\n' +
          '`degraded` deliberately returns **200**: one supplier being down is precisely the failure the ' +
          'workflow absorbs, so a 503 would pull a perfectly capable instance out of rotation. This ' +
          'endpoint backs the container healthcheck.',
        operationId: 'getHealth',
        responses: {
          '200': {
            description: 'Healthy (`ok`) or degraded (`degraded`) — the service is serving traffic either way.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
                examples: {
                  ok: {
                    summary: 'Everything reachable',
                    value: {
                      status: 'ok',
                      suppliers: { A: { status: 'up', latencyMs: 9 }, B: { status: 'up', latencyMs: 10 } },
                      redis: { status: 'up', latencyMs: 3 },
                      temporal: { status: 'up', latencyMs: 14 },
                      checkedAt: '2026-09-21T10:17:57.742Z',
                      uptimeSeconds: 21,
                    },
                  },
                  degraded: {
                    summary: 'One supplier down — still serving from the other',
                    value: {
                      status: 'degraded',
                      suppliers: {
                        A: { status: 'down', latencyMs: 10, error: 'HTTP 503' },
                        B: { status: 'up', latencyMs: 11 },
                      },
                      redis: { status: 'up', latencyMs: 4 },
                      temporal: { status: 'up', latencyMs: 15 },
                      checkedAt: '2026-09-21T10:18:25.078Z',
                      uptimeSeconds: 12,
                    },
                  },
                },
              },
            },
          },
          '503': {
            description: 'A critical dependency is down: Redis, Temporal, or *both* suppliers.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
                example: {
                  status: 'down',
                  suppliers: { A: { status: 'up', latencyMs: 8 }, B: { status: 'up', latencyMs: 9 } },
                  redis: { status: 'down', latencyMs: 2, error: 'PING did not return PONG' },
                  temporal: { status: 'up', latencyMs: 13 },
                  checkedAt: '2026-09-21T10:21:03.118Z',
                  uptimeSeconds: 96,
                },
              },
            },
          },
        },
      },
    },

    '/supplierA/hotels': {
      get: {
        tags: ['Suppliers (mock)'],
        summary: 'Supplier A raw feed',
        description:
          'Mock stand-in for a third-party supplier API, returning `RawHotel` records **before** ' +
          'normalization and deduplication. Compare with Supplier B to see the overlapping names at ' +
          'different prices that `/api/hotels` resolves.\n\n' +
          'Two test switches: `delayMs` simulates latency (makes the parallel fan-out visible), and ' +
          '`fail` returns 503 to exercise graceful degradation.',
        operationId: 'getSupplierAHotels',
        parameters: supplierParameters(),
        responses: supplierResponses('A-DEL-001', 'Holtin', 5200, 12),
      },
    },

    '/supplierB/hotels': {
      get: {
        tags: ['Suppliers (mock)'],
        summary: 'Supplier B raw feed',
        description:
          'Mock stand-in for a third-party supplier API, returning `RawHotel` records **before** ' +
          'normalization and deduplication. Supplier B undercuts Supplier A on Holtin (4950 vs 5200), ' +
          'which is why Supplier B wins that hotel in `/api/hotels`.\n\n' +
          'Two test switches: `delayMs` simulates latency, and `fail` returns 503 to exercise graceful ' +
          'degradation.',
        operationId: 'getSupplierBHotels',
        parameters: supplierParameters(),
        responses: supplierResponses('B-DEL-101', 'Holtin', 4950, 9),
      },
    },
  },
  components: { schemas },
};

function supplierParameters(): OpenAPIV3.ParameterObject[] {
  return [
    {
      name: 'city',
      in: 'query',
      required: false,
      description: 'City to list. Defaults to `delhi`. An unknown city returns `[]`.',
      schema: { type: 'string', default: 'delhi', example: 'delhi' },
    },
    {
      name: 'delayMs',
      in: 'query',
      required: false,
      description: 'Simulate supplier latency before responding. Clamped to 10000.',
      schema: { type: 'integer', minimum: 0, maximum: 10000, example: 1500 },
    },
    {
      name: 'fail',
      in: 'query',
      required: false,
      description: 'Set to `1` to respond 503, simulating a supplier outage.',
      schema: { type: 'string', enum: ['1', 'true'] },
    },
  ];
}

function supplierResponses(
  hotelId: string,
  name: string,
  price: number,
  commissionPct: number,
): OpenAPIV3.ResponsesObject {
  return {
    '200': {
      description: 'The supplier’s raw hotel list for the city. Empty array for an unknown city.',
      content: {
        'application/json': {
          schema: { type: 'array', items: { $ref: '#/components/schemas/RawHotel' } },
          example: [{ hotelId, name, price, city: 'delhi', commissionPct }],
        },
      },
    },
    '503': {
      description: 'Simulated supplier outage, returned when `fail=1`.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
          example: { error: 'supplier_unavailable', message: 'Supplier A is down' },
        },
      },
    },
  };
}
